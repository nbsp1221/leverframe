import { afterEach, expect, it, vi } from 'vitest';
import { PUT } from '../../../app/api/v1/[...path]/route';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('rejects cross-origin settings writes before forwarding and preserves same-origin settings bodies', async () => {
  vi.stubEnv('REVIEWER_INTERNAL_URL', 'http://127.0.0.1:1234/');
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', upstream);
  const body = JSON.stringify({ model: 'gpt-6-astra', reasoningEffort: 'high' });

  const send = (origin: string) =>
    PUT(
      new Request('http://localhost/api/v1/settings/reviews', {
        method: 'PUT',
        headers: { origin, 'content-type': 'application/json' },
        body,
      }),
      { params: Promise.resolve({ path: ['settings', 'reviews'] }) },
    );

  expect((await send('https://another-origin.invalid')).status).toBe(403);
  expect(upstream).not.toHaveBeenCalled();
  expect((await send('http://localhost')).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(upstream.mock.calls[0]?.[0]).toEqual(
    new URL('http://127.0.0.1:1234/api/v1/settings/reviews'),
  );
  expect(Buffer.from(upstream.mock.calls[0]?.[1]?.body as ArrayBuffer).toString()).toBe(body);
});
