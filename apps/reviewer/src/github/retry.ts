function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericHeader(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function githubRetryDelayMilliseconds(error: unknown, attempt: number): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const headers = asRecord(response?.headers);
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const retryAfterSeconds = numericHeader(headers?.['retry-after']);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return Math.min(
      30_000,
      retryAfterSeconds === undefined ? 500 * 2 ** attempt : retryAfterSeconds * 1_000,
    );
  }
  if (
    status === 403 &&
    (retryAfterSeconds !== undefined || String(headers?.['x-ratelimit-remaining']) === '0')
  ) {
    const resetAtSeconds = numericHeader(headers?.['x-ratelimit-reset']);
    const resetDelay =
      resetAtSeconds === undefined ? undefined : resetAtSeconds * 1_000 - Date.now();
    return Math.min(
      30_000,
      Math.max(
        0,
        retryAfterSeconds === undefined
          ? (resetDelay ?? 1_000 * 2 ** attempt)
          : retryAfterSeconds * 1_000,
      ),
    );
  }

  if (response !== undefined || (status !== undefined && status !== 500)) {
    return undefined;
  }
  // Octokit wraps fetch failures, which can wrap the native network error again.
  // Bound traversal because error causes can cycle.
  let cause = record;
  for (let depth = 0; cause !== undefined && depth < 5; depth += 1) {
    if (
      typeof cause.code === 'string' &&
      ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(cause.code)
    ) {
      return 500 * 2 ** attempt;
    }
    cause = asRecord(cause.cause);
  }
  return undefined;
}

export async function withGitHubRetry<T>(
  operation: () => Promise<T>,
  retryDelayMilliseconds = githubRetryDelayMilliseconds,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMilliseconds = retryDelayMilliseconds(error, attempt);
      if (delayMilliseconds === undefined || attempt >= 2) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMilliseconds);
      });
    }
  }
}
