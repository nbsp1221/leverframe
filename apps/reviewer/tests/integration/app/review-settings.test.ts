import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewSettingsResponseSchema } from '@repo/contracts/review-settings';
import { afterEach, describe, expect, it } from 'vitest';
import { loadServerConfig } from '../../../src/app/config.js';
import { createLeverframeServer } from '../../../src/app/server.js';
import { CredentialStore } from '../../../src/github/credentials.js';
import { JobDatabase } from '../../../src/jobs/database.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});

async function start(root: string, model = 'gpt-6-astra', uiBaseUrl = 'http://localhost') {
  const config = loadServerConfig({
    APP_DATA_DIRECTORY: root,
    APP_RESOURCES_DIRECTORY: fileURLToPath(new URL('../../../resources', import.meta.url)),
    APP_UI_BASE_URL: uiBaseUrl,
    GITHUB_ALLOWED_OWNER_ID: '1',
    GITHUB_APP_NAME: 'review-settings-test',
    GITHUB_WEBHOOK_URL: 'http://localhost/webhooks/github',
    REVIEW_SANDBOX_TEMPLATE: `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
    REVIEW_MODEL: model,
    REVIEW_REASONING_EFFORT: 'high',
  });
  const database = new JobDatabase(config.databasePath);
  const server = createLeverframeServer(
    config,
    database,
    new CredentialStore(config.credentialsDirectory),
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    });
    database.close();
  };

  cleanup.push(() => {
    if (server.listening) {
      server.closeAllConnections();
      server.close();
      database.close();
    }
  });
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/settings/reviews`;
  return { database, endpoint, close };
}

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-settings-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

describe('Review model settings API', () => {
  it('accepts the configured public UI origin over an HTTP proxy upstream', async () => {
    const { endpoint } = await start(temporaryRoot(), 'gpt-6-astra', 'https://app.example.com');
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        'host': 'app.example.com',
        'origin': 'https://app.example.com',
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'app.example.com',
      },
      body: JSON.stringify({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }),
    });
    expect(response.status).toBe(200);
  });

  it('ignores forwarded-origin claims and enforces body limits at the backend', async () => {
    const { endpoint } = await start(temporaryRoot(), 'gpt-6-astra', 'https://app.example.com');
    for (const origin of ['https://untrusted.example', 'null', new URL(endpoint).origin]) {
      const response = await fetch(endpoint, {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          origin,
          'x-forwarded-host': 'app.example.com',
          'x-forwarded-proto': 'https',
        },
        body: JSON.stringify({ model: 'gpt-6.1-sol', reasoningEffort: 'high' }),
      });
      expect(response.status).toBe(403);
    }
    const oversized = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'x'.repeat(1024 * 1024), reasoningEffort: 'high' }),
    });
    expect(oversized.status).toBe(413);
  });

  it('persists both fields through server restart and overrides changed environment defaults', async () => {
    const root = temporaryRoot();
    const first = await start(root);
    const initial = reviewSettingsResponseSchema.parse(await (await fetch(first.endpoint)).json());
    expect(initial.current).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
    expect(initial.models.map((model) => model.id)).toContain('gpt-6.1-sol');
    const selected = { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' };
    const saved = await fetch(first.endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(selected),
    });
    expect(saved.status).toBe(200);
    expect(reviewSettingsResponseSchema.parse(await saved.json()).current).toEqual(selected);
    await first.close();
    const second = await start(root, 'another-startup-default');
    expect(
      reviewSettingsResponseSchema.parse(await (await fetch(second.endpoint)).json()).current,
    ).toEqual(selected);
    await second.close();
  });

  it('preserves an existing model outside the picker instead of silently replacing it', async () => {
    const { endpoint } = await start(temporaryRoot(), 'custom-existing-model');
    expect(
      reviewSettingsResponseSchema.parse(await (await fetch(endpoint)).json()).current.model,
    ).toBe('custom-existing-model');
  });

  it.each([
    { model: 'invented-model', reasoningEffort: 'high' },
    { model: 'gpt-6-astra', reasoningEffort: 'ultra' },
    { model: 'gpt-6-astra', reasoningEffort: 'none' },
    { model: 'gpt-6-astra' },
    { model: 'gpt-6-astra', reasoningEffort: 'high', unexpected: true },
  ])('rejects unsupported settings without changing the current pair: %j', async (body) => {
    const { endpoint } = await start(temporaryRoot());
    const response = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(422);
    expect(
      reviewSettingsResponseSchema.parse(await (await fetch(endpoint)).json()).current,
    ).toEqual({ model: 'gpt-6-astra', reasoningEffort: 'high' });
  });

  it('rejects cross-origin writes and malformed JSON', async () => {
    const { endpoint } = await start(temporaryRoot());
    const crossOrigin = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'origin': 'https://another-origin.invalid' },
      body: JSON.stringify({ model: 'gpt-6.1-sol', reasoningEffort: 'low' }),
    });
    expect(crossOrigin.status).toBe(403);
    const malformed = await fetch(endpoint, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(422);
    expect(
      reviewSettingsResponseSchema.parse(await (await fetch(endpoint)).json()).current.model,
    ).toBe('gpt-6-astra');
  });
});
