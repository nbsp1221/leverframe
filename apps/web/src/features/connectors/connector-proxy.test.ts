import { afterEach, expect, it, vi } from 'vitest';
import { POST } from '../../../app/api/v1/[...path]/route';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('forwards long authenticated observation results without raising other request limits', async () => {
  vi.stubEnv('REVIEWER_INTERNAL_URL', 'http://127.0.0.1:1234');
  const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('{}'));
  vi.stubGlobal('fetch', upstream);
  const body = JSON.stringify({ ok: true, snapshot: { messages: ['x'.repeat(2 * 1024 * 1024)] } });

  const send = (path: string[]) =>
    POST(
      new Request(`http://localhost/api/v1/${path.join('/')}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer scoped-test' },
        body,
      }),
      { params: Promise.resolve({ path }) },
    );

  expect((await send(['connectors', 'agent', 'results', 'command'])).status).toBe(200);
  expect(upstream).toHaveBeenCalledTimes(1);
  expect(new Headers(upstream.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
    'Bearer scoped-test',
  );
  expect((await send(['connectors', 'pairings'])).status).toBe(413);
  expect(upstream).toHaveBeenCalledTimes(1);
});
