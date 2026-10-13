import { expect, test } from '@playwright/test';
import { pairingSchema } from '@repo/contracts/connectors';

test('serves the UI, API, setup and local API documentation through Next.js alone', async ({
  request,
  baseURL,
}) => {
  expect((await request.get('/en/reviews')).status()).toBe(200);
  expect((await request.get('/healthz')).status()).toBe(200);
  const setup = await request.get('/setup/github', { maxRedirects: 0 });
  expect(setup.status()).toBe(409);
  expect(await setup.text()).toContain('GitHub App is already registered');
  const contract = await request.get('/openapi.json');
  expect(contract.status()).toBe(200);
  expect(await contract.json()).toHaveProperty('openapi', '3.1.0');
  const docs = await request.get('/docs');
  expect(docs.status()).toBe(200);
  const asset = (await docs.text()).match(/src="(\/docs\/assets\/scalar-[0-9a-f]{16}\.js)"/)?.[1];
  expect(asset).toBeDefined();
  expect((await request.get(asset!)).status()).toBe(200);
  expect((await request.get('/llms.txt')).status()).toBe(200);

  const pair = { model: 'gpt-6-astra', reasoningEffort: 'high' };
  expect(
    (
      await request.put('/api/v1/settings/reviews', { headers: { origin: baseURL! }, data: pair })
    ).status(),
  ).toBe(200);
  expect(
    (
      await request.put('/api/v1/settings/reviews', {
        headers: {
          'origin': 'https://untrusted.example',
          'x-forwarded-host': new URL(baseURL!).host,
          'x-forwarded-proto': 'https',
        },
        data: pair,
      })
    ).status(),
  ).toBe(403);
  expect(
    (
      await request.put('/api/v1/settings/reviews', {
        data: { model: 'x'.repeat(1024 * 1024), reasoningEffort: 'high' },
      })
    ).status(),
  ).toBe(413);
});

test('forwards authenticated conversation results above 10 MB and retains the smaller admin limit', async ({
  request,
}) => {
  const pair = await request.post('/api/v1/connectors/pairings', { data: {} });
  expect(pair.status()).toBe(200);
  const { code } = pairingSchema.parse(await pair.json());
  const enrolled = await request.post('/api/v1/connectors/enroll', {
    data: { code, name: 'Transport test', hostname: 'test-machine' },
  });
  expect(enrolled.status()).toBe(200);
  const identity = (await enrolled.json()) as { id: string; token: string };
  try {
    const response = await request.post('/api/v1/connectors/agent/results/unknown-test-command', {
      headers: { authorization: `Bearer ${identity.token}` },
      data: {
        ok: true,
        snapshot: { revision: 'test', state: 'ready', messages: ['x'.repeat(16 * 1024 * 1024)] },
      },
    });
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const oversized = await request.post('/api/v1/connectors/pairings', {
      data: { padding: 'x'.repeat(1024 * 1024) },
    });
    expect(oversized.status()).toBe(413);
  } finally {
    expect(
      (await request.post(`/api/v1/connectors/${identity.id}/revoke`, { data: {} })).status(),
    ).toBe(200);
  }
});
