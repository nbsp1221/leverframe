import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { PullRequestCancellationInput, PullRequestJobInput } from '../jobs/database.js';
import { type ManualCommand, normalizeManualCommand } from '../jobs/command.js';

const supportedActions = new Set(['opened', 'synchronize', 'reopened', 'ready_for_review']);
const cancellationActions = new Set(['closed', 'converted_to_draft']);

const repositoryOwnerSchema = z.object({
  repository: z.object({ owner: z.object({ id: z.number().int().positive() }) }),
});

const pullRequestWebhookSchema = z.object({
  action: z.string(),
  after: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  before: z
    .string()
    .regex(/^[0-9a-f]{40}$/i)
    .optional(),
  installation: z.object({ id: z.number().int().positive() }),
  pull_request: z.object({
    draft: z.boolean(),
    head: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/i) }),
    merged: z.boolean().optional(),
    number: z.number().int().positive(),
    title: z.string(),
  }),
  repository: z.object({ full_name: z.string().min(3) }),
});

export type WebhookDecision =
  | { cancellation: PullRequestCancellationInput; kind: 'cancel' }
  | { command: ManualCommand; kind: 'command' }
  | { kind: 'enqueue'; job: PullRequestJobInput }
  | { kind: 'ignore'; reason: string };

export function createWebhookSignature(body: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

export function verifyWebhookSignature(
  body: Buffer,
  signature: string | undefined,
  secret: string,
): boolean {
  if (signature === undefined) {
    return false;
  }

  const expected = Buffer.from(createWebhookSignature(body, secret));
  const actual = Buffer.from(signature);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function decideWebhook(input: {
  allowedOwnerId?: number;
  body: Buffer;
  deliveryId: string;
  event: string;
  policyVersion?: string;
}): WebhookDecision {
  if (input.event === 'issue_comment' || input.event === 'pull_request') {
    const owner = repositoryOwnerSchema.parse(JSON.parse(input.body.toString('utf8')));
    if (input.allowedOwnerId !== undefined && owner.repository.owner.id !== input.allowedOwnerId) {
      return { kind: 'ignore', reason: 'repository owner is not allowed' };
    }
  }
  if (input.event === 'issue_comment') {
    const command = normalizeManualCommand({
      body: input.body,
      deliveryId: input.deliveryId,
    });
    return command === undefined
      ? { kind: 'ignore', reason: 'not an actionable pull request command' }
      : { command, kind: 'command' };
  }
  if (input.event !== 'pull_request') {
    return { kind: 'ignore', reason: `unsupported event: ${input.event}` };
  }

  const payload = pullRequestWebhookSchema.parse(JSON.parse(input.body.toString('utf8')));

  if (cancellationActions.has(payload.action)) {
    return {
      cancellation: {
        action: payload.action as PullRequestCancellationInput['action'],
        deliveryId: input.deliveryId,
        headSha: payload.pull_request.head.sha,
        installationId: payload.installation.id,
        ...(payload.pull_request.merged === true ? { merged: true } : {}),
        pullRequestNumber: payload.pull_request.number,
        repository: payload.repository.full_name,
      },
      kind: 'cancel',
    };
  }

  if (!supportedActions.has(payload.action)) {
    return { kind: 'ignore', reason: `unsupported action: ${payload.action}` };
  }

  if (payload.pull_request.draft && payload.action !== 'ready_for_review') {
    return { kind: 'ignore', reason: 'draft pull request' };
  }

  if (
    payload.action === 'synchronize' &&
    payload.before !== undefined &&
    payload.before === payload.after
  ) {
    return { kind: 'ignore', reason: 'synchronize event did not change the head' };
  }

  return {
    kind: 'enqueue',
    job: {
      action: payload.action,
      deliveryId: input.deliveryId,
      headSha: payload.pull_request.head.sha,
      installationId: payload.installation.id,
      policyVersion: input.policyVersion ?? 'v2',
      pullRequestNumber: payload.pull_request.number,
      pullRequestTitle: payload.pull_request.title,
      repository: payload.repository.full_name,
    },
  };
}
