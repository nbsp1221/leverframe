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

  const code = typeof record?.code === 'string' ? record.code : undefined;
  return code !== undefined && ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
    ? 500 * 2 ** attempt
    : undefined;
}

export async function withGitHubRetry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delayMilliseconds = githubRetryDelayMilliseconds(error, attempt);
      if (delayMilliseconds === undefined || attempt >= 2) {
        throw error;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, delayMilliseconds);
      });
    }
  }
}
