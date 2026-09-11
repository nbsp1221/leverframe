import { describe, expect, it } from 'vitest';
import { normalizeManualCommand, parseManualCommand } from '../../../src/jobs/command.js';

function payload(overrides: { body?: string; pullRequest?: boolean; userType?: string } = {}) {
  return Buffer.from(
    JSON.stringify({
      action: 'created',
      comment: {
        body: overrides.body ?? '@leverframe review',
        id: 99,
        user: { login: 'octocat', type: overrides.userType ?? 'User' },
      },
      installation: { id: 42 },
      issue: {
        number: 7,
        ...(overrides.pullRequest === false ? {} : { pull_request: { url: 'example' } }),
      },
      repository: { full_name: 'example/project' },
    }),
  );
}

describe('manual review commands', () => {
  it('accepts only the fixed grammar at the start of a comment', () => {
    expect(parseManualCommand('@leverframe cancel', 'leverframe')).toBe('cancel');
    expect(parseManualCommand('@leverframe retry', 'leverframe')).toBe('retry');
    expect(parseManualCommand('@leverframe review', 'leverframe')).toBe('review');
    expect(parseManualCommand('@leverframe review full\nplease run it', 'leverframe')).toBe(
      'review_full',
    );
    expect(parseManualCommand('@leverframe status', 'leverframe')).toBe('status');
    expect(parseManualCommand('@example-reviewer status', 'example-reviewer')).toBe('status');
    expect(parseManualCommand('@leverframe status', 'example-reviewer')).toBeUndefined();
    expect(parseManualCommand('please @leverframe review', 'leverframe')).toBeUndefined();
    expect(
      parseManualCommand('@leverframe review --model expensive', 'leverframe'),
    ).toBeUndefined();
    expect(parseManualCommand('/retn0 review', 'leverframe')).toBeUndefined();
  });

  it('normalizes human pull request comments and ignores bots and issues', () => {
    expect(
      normalizeManualCommand({
        appSlug: 'leverframe',
        body: payload(),
        deliveryId: 'delivery-1',
      }),
    ).toMatchObject({
      actor: 'octocat',
      command: 'review',
      pullRequestNumber: 7,
    });
    expect(
      normalizeManualCommand({
        appSlug: 'leverframe',
        body: payload({ userType: 'Bot' }),
        deliveryId: 'delivery-2',
      }),
    ).toBeUndefined();
    expect(
      normalizeManualCommand({
        appSlug: 'leverframe',
        body: payload({ pullRequest: false }),
        deliveryId: 'delivery-3',
      }),
    ).toBeUndefined();
  });
});
