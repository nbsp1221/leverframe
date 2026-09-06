import { z } from 'zod';

export type ManualCommandName = 'cancel' | 'retry' | 'review' | 'review_full' | 'status';

export interface ManualCommand {
  actor: string;
  command: ManualCommandName;
  commentId: number;
  deliveryId: string;
  installationId: number;
  pullRequestNumber: number;
  repository: string;
}

const issueCommentSchema = z.object({
  action: z.string(),
  comment: z.object({
    body: z.string(),
    id: z.number().int().positive(),
    user: z.object({
      login: z.string().min(1),
      type: z.string(),
    }),
  }),
  installation: z.object({ id: z.number().int().positive() }),
  issue: z.object({
    number: z.number().int().positive(),
    pull_request: z.unknown().optional(),
  }),
  repository: z.object({ full_name: z.string().min(3) }),
});

const commands = new Map<string, ManualCommandName>([
  ['@leverframe cancel', 'cancel'],
  ['@leverframe retry', 'retry'],
  ['@leverframe review', 'review'],
  ['@leverframe review full', 'review_full'],
  ['@leverframe status', 'status'],
]);

export function parseManualCommand(body: string): ManualCommandName | undefined {
  const firstLine = body.split(/\r?\n/, 1)[0]?.trim();
  return firstLine === undefined ? undefined : commands.get(firstLine);
}

export function normalizeManualCommand(input: {
  body: Buffer;
  deliveryId: string;
}): ManualCommand | undefined {
  const payload = issueCommentSchema.parse(JSON.parse(input.body.toString('utf8')));
  if (
    payload.action !== 'created' ||
    payload.issue.pull_request === undefined ||
    payload.comment.user.type.toLowerCase() === 'bot'
  ) {
    return undefined;
  }
  const command = parseManualCommand(payload.comment.body);
  if (command === undefined) {
    return undefined;
  }
  return {
    actor: payload.comment.user.login,
    command,
    commentId: payload.comment.id,
    deliveryId: input.deliveryId,
    installationId: payload.installation.id,
    pullRequestNumber: payload.issue.number,
    repository: payload.repository.full_name,
  };
}
