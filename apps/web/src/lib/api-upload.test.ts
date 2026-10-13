import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it('drains a chunked oversized upload without retaining it until EOF', () => {
  const handler = new URL('../../app/api/v1/[...path]/route.ts', import.meta.url).href;
  // A separate process gives GC and memory observations their own baseline.
  const output = execFileSync(
    process.execPath,
    ['--expose-gc', '--import', 'tsx', '--input-type=module'],
    {
      input: `
        const { PUT } = await import(${JSON.stringify(handler)});
        process.env.REVIEWER_INTERNAL_URL = 'http://127.0.0.1:1';
        global.gc();
        const baseline = process.memoryUsage().arrayBuffers;
        let sent = 0;
        let retained = 0;
        const body = new ReadableStream({
          async pull(controller) {
            if (sent++ === 128) {
              for (let pass = 0; pass < 3; pass++) {
                await new Promise(resolve => setImmediate(resolve));
                global.gc();
              }
              retained = process.memoryUsage().arrayBuffers - baseline;
              controller.close();
              return;
            }
            controller.enqueue(new Uint8Array(1024 * 1024));
          }
        });
        const request = new Request('http://localhost/api/v1/settings/reviews', {
          method: 'PUT', body, duplex: 'half'
        });
        const response = await PUT(request, {
          params: Promise.resolve({ path: ['settings', 'reviews'] })
        });
        console.log(JSON.stringify({ status: response.status, retained }));
      `,
      encoding: 'utf8',
      timeout: 30_000,
    },
  );
  const result = JSON.parse(output) as { status: number; retained: number };
  expect(result.status).toBe(413);
  expect(result.retained).toBeLessThan(16 * 1024 * 1024);
});
