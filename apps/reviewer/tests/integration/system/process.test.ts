import { describe, expect, it } from 'vitest';
import { runProcess, runStreamingProcess } from '../../../src/system/process.js';

describe('runProcess cancellation', () => {
  it('stops a running child when the external signal is aborted', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const processPromise = runProcess(
      process.execPath,
      ['-e', 'setInterval(() => undefined, 1_000)'],
      {
        signal: controller.signal,
        timeoutMilliseconds: 10_000,
      },
    );

    setTimeout(() => controller.abort(), 50);

    await expect(processPromise).rejects.toMatchObject({ isCanceled: true });
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });
});

describe('runStreamingProcess', () => {
  it('delivers output before the child exits and retains a bounded tail', async () => {
    const chunks: string[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstChunk = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const processPromise = runStreamingProcess(
      process.execPath,
      [
        '-e',
        'process.stdout.write("first\\n"); setTimeout(() => process.stdout.write("second\\n"), 100)',
      ],
      {
        onStdout: (chunk) => {
          chunks.push(Buffer.from(chunk).toString('utf8'));
          resolveFirst?.();
        },
        tailBytes: 7,
      },
    );
    await firstChunk;
    expect(chunks.join('')).toContain('first');
    const result = await processPromise;
    expect(result.stdout).toBe('second\n');
  });
});
