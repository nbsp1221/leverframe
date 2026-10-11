import { describe, expect, it } from 'vitest';
import { githubRetryDelayMilliseconds } from '../../../src/github/retry.js';

describe('wrapped GitHub network errors', () => {
  it.each(['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'])('recognizes a nested %s', (code) => {
    const error = Object.assign(new Error('SDK request failed'), {
      cause: new TypeError('fetch failed', {
        cause: Object.assign(new Error('network failed'), { code }),
      }),
      status: 500,
    });
    expect(githubRetryDelayMilliseconds(error, 0)).toBe(500);
    expect(githubRetryDelayMilliseconds(error, 1)).toBe(1_000);
  });

  it.each([401, 403, 404, 422, 500])(
    'does not treat an HTTP %i response as a network failure',
    (status) => {
      expect(
        githubRetryDelayMilliseconds(
          {
            cause: { code: 'ECONNRESET' },
            response: { headers: {}, status },
            status,
          },
          0,
        ),
      ).toBeUndefined();
    },
  );

  it('does not retry unknown network errors or a bare SDK 500', () => {
    expect(
      githubRetryDelayMilliseconds({ cause: { code: 'EACCES' }, status: 500 }, 0),
    ).toBeUndefined();
    expect(githubRetryDelayMilliseconds({ status: 500 }, 0)).toBeUndefined();
  });

  it('terminates on cyclic causes', () => {
    const error: { cause?: unknown } = {};
    error.cause = error;
    expect(githubRetryDelayMilliseconds(error, 0)).toBeUndefined();
  });

  it('does not inspect more than five error objects', () => {
    let error: unknown = { code: 'ECONNRESET' };
    for (let depth = 0; depth < 5; depth += 1) {
      error = { cause: error };
    }
    expect(githubRetryDelayMilliseconds(error, 0)).toBeUndefined();
  });
});
