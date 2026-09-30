import { setTimeout } from 'node:timers/promises';

const initialRetryDelayMilliseconds = 5_000;
const maximumRetryDelayMilliseconds = 60_000;

export async function startReviewWorkerWhenReady(input: {
  preflight: (signal: AbortSignal) => Promise<string>;
  startWorker: () => void;
  signal: AbortSignal;
  retryDelayMilliseconds?: (failures: number) => number;
}): Promise<void> {
  let failures = 0;

  while (!input.signal.aborted) {
    let evidence: string;
    try {
      evidence = await input.preflight(input.signal);
    } catch (error) {
      if (input.signal.aborted) {
        return;
      }
      failures += 1;
      const delay =
        input.retryDelayMilliseconds?.(failures) ??
        Math.min(
          maximumRetryDelayMilliseconds,
          initialRetryDelayMilliseconds * 2 ** (failures - 1),
        );
      console.error(
        `sandbox preflight failed (attempt ${failures}); retrying review worker startup in ${delay}ms`,
        error,
      );
      try {
        await setTimeout(delay, undefined, { signal: input.signal });
      } catch (error) {
        if (input.signal.aborted) {
          return;
        }
        throw error;
      }
      continue;
    }
    if (input.signal.aborted) {
      return;
    }
    console.log(`sandbox preflight passed\n${evidence}`);
    input.startWorker();
    return;
  }
}
