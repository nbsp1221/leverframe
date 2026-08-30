import { describe, expect, it } from 'vitest';
import {
  createWebhookSignature,
  decideWebhook,
  verifyWebhookSignature,
} from '../../../src/github/webhook.js';

function pullRequestBody(
  overrides: {
    action?: string;
    after?: string;
    before?: string;
    draft?: boolean;
    ownerId?: number;
    title?: string;
  } = {},
): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: overrides.action ?? 'opened',
      ...(overrides.after === undefined ? {} : { after: overrides.after }),
      ...(overrides.before === undefined ? {} : { before: overrides.before }),
      installation: { id: 42 },
      pull_request: {
        draft: overrides.draft ?? false,
        head: { sha: 'a'.repeat(40) },
        number: 7,
        title: overrides.title ?? 'Preserve this pull request title',
      },
      repository: {
        full_name: 'example/project',
        owner: { id: overrides.ownerId ?? 1 },
      },
    }),
  );
}

describe('GitHub webhook intake', () => {
  it('verifies the raw request body signature', () => {
    const body = pullRequestBody();
    const secret = 'a-secret-long-enough';

    expect(verifyWebhookSignature(body, createWebhookSignature(body, secret), secret)).toBe(true);
    expect(
      verifyWebhookSignature(Buffer.from('tampered'), createWebhookSignature(body, secret), secret),
    ).toBe(false);
  });

  it('normalizes a supported pull request event into a job', () => {
    const decision = decideWebhook({
      body: pullRequestBody(),
      deliveryId: 'delivery-1',
      event: 'pull_request',
    });

    expect(decision).toEqual({
      kind: 'enqueue',
      job: {
        action: 'opened',
        deliveryId: 'delivery-1',
        headSha: 'a'.repeat(40),
        installationId: 42,
        policyVersion: 'v2',
        pullRequestNumber: 7,
        pullRequestTitle: 'Preserve this pull request title',
        repository: 'example/project',
      },
    });
  });

  it('ignores repositories outside the configured owner account', () => {
    expect(
      decideWebhook({
        allowedOwnerId: 1,
        body: pullRequestBody({ ownerId: 2 }),
        deliveryId: 'delivery-owner',
        event: 'pull_request',
      }),
    ).toEqual({ kind: 'ignore', reason: 'repository owner is not allowed' });
  });

  it('ignores drafts, no-op synchronizations, and unrelated actions', () => {
    expect(
      decideWebhook({
        body: pullRequestBody({ draft: true }),
        deliveryId: 'delivery-1',
        event: 'pull_request',
      }),
    ).toEqual({ kind: 'ignore', reason: 'draft pull request' });

    expect(
      decideWebhook({
        body: pullRequestBody({ action: 'labeled' }),
        deliveryId: 'delivery-2',
        event: 'pull_request',
      }),
    ).toEqual({ kind: 'ignore', reason: 'unsupported action: labeled' });

    expect(
      decideWebhook({
        body: pullRequestBody({
          action: 'synchronize',
          after: 'b'.repeat(40),
          before: 'b'.repeat(40),
        }),
        deliveryId: 'delivery-3',
        event: 'pull_request',
      }),
    ).toEqual({ kind: 'ignore', reason: 'synchronize event did not change the head' });
  });

  it.each(['closed', 'converted_to_draft'] as const)(
    'normalizes the %s lifecycle event into a cancellation',
    (action) => {
      expect(
        decideWebhook({
          body: pullRequestBody({ action, draft: action === 'converted_to_draft' }),
          deliveryId: 'delivery-4',
          event: 'pull_request',
        }),
      ).toEqual({
        cancellation: {
          action,
          deliveryId: 'delivery-4',
          headSha: 'a'.repeat(40),
          installationId: 42,
          pullRequestNumber: 7,
          repository: 'example/project',
        },
        kind: 'cancel',
      });
    },
  );
});
