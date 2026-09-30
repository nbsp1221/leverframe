import { describe, expect, it, vi } from 'vitest';
import { startReviewWorkerWhenReady } from '../../../src/jobs/review-worker-startup.js';

describe('review worker startup', () => {
  it('recovers after a sustained outage without exhausting retries or starting twice', async () => {
    let attempts = 0;
    const preflight = vi.fn(() => {
      attempts += 1;
      if (attempts <= 10) {
        return Promise.reject(new Error('sandbox daemon unavailable'));
      }
      return Promise.resolve('sandbox ready');
    });
    const startWorker = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const successLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      const startup = startReviewWorkerWhenReady({
        preflight,
        startWorker,
        signal: new AbortController().signal,
        retryDelayMilliseconds: () => 1,
      });
      await startup;

      expect(preflight).toHaveBeenCalledTimes(11);
      expect(startWorker).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenLastCalledWith(
        'sandbox preflight failed (attempt 10); retrying review worker startup in 1ms',
        expect.any(Error),
      );
    } finally {
      errorLog.mockRestore();
      successLog.mockRestore();
    }
  });

  it('starts the worker after a failed preflight recovers', async () => {
    const preflight = vi
      .fn<(_: AbortSignal) => Promise<string>>()
      .mockRejectedValueOnce(new Error('sandbox daemon unavailable'))
      .mockResolvedValue('sandbox ready');
    const startWorker = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const successLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      await startReviewWorkerWhenReady({
        preflight,
        startWorker,
        signal: new AbortController().signal,
        retryDelayMilliseconds: () => 1,
      });

      expect(preflight).toHaveBeenCalledTimes(2);
      expect(startWorker).toHaveBeenCalledOnce();
      expect(errorLog).toHaveBeenCalledOnce();
      expect(successLog).toHaveBeenCalledWith('sandbox preflight passed\nsandbox ready');
    } finally {
      errorLog.mockRestore();
      successLog.mockRestore();
    }
  });

  it('stops retrying on shutdown', async () => {
    const controller = new AbortController();
    const preflight = vi.fn().mockRejectedValue(new Error('sandbox daemon unavailable'));
    const startWorker = vi.fn();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const startup = startReviewWorkerWhenReady({
        preflight,
        startWorker,
        signal: controller.signal,
        retryDelayMilliseconds: () => 60_000,
      });
      await vi.waitFor(() => expect(preflight).toHaveBeenCalledOnce());
      controller.abort();
      await startup;

      expect(preflight).toHaveBeenCalledOnce();
      expect(startWorker).not.toHaveBeenCalled();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('does not start the worker if shutdown happens during preflight', async () => {
    const controller = new AbortController();

    let finishPreflight: (evidence: string) => void = () => undefined;

    const preflight = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finishPreflight = resolve;
        }),
    );
    const startWorker = vi.fn();
    const startup = startReviewWorkerWhenReady({
      preflight,
      startWorker,
      signal: controller.signal,
    });

    controller.abort();
    finishPreflight('sandbox ready');
    await startup;

    expect(startWorker).not.toHaveBeenCalled();
  });
});
