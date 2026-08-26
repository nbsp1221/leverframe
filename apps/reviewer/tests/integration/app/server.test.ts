import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/app/config.js';
import { createLeverframeServer } from '../../../src/app/server.js';
import { CredentialStore } from '../../../src/github/credentials.js';
import { createWebhookSignature } from '../../../src/github/webhook.js';
import { JobDatabase } from '../../../src/jobs/database.js';

const secret = 'a-secret-long-enough';
const config: ServerConfig = {
  allowedOwnerId: 1,
  credentialsDirectory: '/unused',
  databasePath: ':memory:',
  host: '127.0.0.1',
  jobsDirectory: '/unused/jobs',
  githubAppName: 'test-leverframe-app',
  model: 'gpt-5.6-luna',
  port: 6571,
  uiBaseUrl: 'https://leverframe.retn0.dev',
  webhookUrl: 'https://leverframe-api.retn0.dev/webhooks/github',
  reasoningEffort: 'low',
  resourcesDirectory: '/unused/resources',
  sandboxTemplate: `ghcr.io/example/template@sha256:${'a'.repeat(64)}`,
};

const resources: Array<() => void> = [];

afterEach(() => {
  for (const close of resources.splice(0)) {
    close();
  }
});

async function startServer(hooks: Parameters<typeof createLeverframeServer>[3] = {}) {
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'leverframe-test-'));
  const credentials = new CredentialStore(temporaryDirectory);
  credentials.write({
    appId: 42,
    clientId: 'client-id',
    name: 'leverframe',
    privateKey: 'private-key',
    slug: 'leverframe',
    webhookSecret: secret,
  });
  const database = new JobDatabase(':memory:');
  const server = createLeverframeServer(config, database, credentials, hooks);
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  resources.push(
    () => server.close(),
    () => {
      if (database.isAvailable()) {
        database.close();
      }
    },
    () => rmSync(temporaryDirectory, { force: true, recursive: true }),
  );
  const address = server.address() as AddressInfo;
  return { database, url: `http://127.0.0.1:${address.port}` };
}

function webhookBody(action = 'opened', draft = false): Buffer {
  return Buffer.from(
    JSON.stringify({
      action,
      installation: { id: 42 },
      pull_request: {
        draft,
        head: { sha: 'a'.repeat(40) },
        number: 7,
      },
      repository: { full_name: 'example/project', owner: { id: 1 } },
    }),
  );
}

function commandBody(): Buffer {
  return Buffer.from(
    JSON.stringify({
      action: 'created',
      comment: {
        body: '/retn0 status',
        id: 99,
        user: { login: 'octocat', type: 'User' },
      },
      installation: { id: 42 },
      issue: { number: 7, pull_request: { url: 'example' } },
      repository: { full_name: 'example/project', owner: { id: 1 } },
    }),
  );
}

describe('Leverframe server', () => {
  it('reports health', async () => {
    const { url } = await startServer();
    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok' });
  });

  it('reports unhealthy when the worker is not running', async () => {
    const { url } = await startServer({ isWorkerRunning: () => false });
    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: 'unhealthy' });
  });

  it('reports unhealthy when the database is unavailable', async () => {
    const { database, url } = await startServer();
    database.close();
    const response = await fetch(`${url}/healthz`);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: 'unhealthy' });
  });

  it('rejects an invalid signature before accepting a job', async () => {
    const { database, url } = await startServer();
    const body = webhookBody();
    const response = await fetch(`${url}/webhooks/github`, {
      body: body.toString('utf8'),
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-1',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': 'sha256=invalid',
      },
      method: 'POST',
    });

    expect(response.status).toBe(401);
    expect(database.countJobs()).toBe(0);
  });

  it('queues a valid delivery exactly once', async () => {
    const queuedHeads: string[] = [];
    const { database, url } = await startServer({
      onJobQueued: (job) => queuedHeads.push(job.headSha),
    });
    const body = webhookBody();
    const headers = {
      'content-type': 'application/json',
      'x-github-delivery': 'delivery-1',
      'x-github-event': 'pull_request',
      'x-hub-signature-256': createWebhookSignature(body, secret),
    };

    const first = await fetch(`${url}/webhooks/github`, {
      body: body.toString('utf8'),
      headers,
      method: 'POST',
    });
    const duplicate = await fetch(`${url}/webhooks/github`, {
      body: body.toString('utf8'),
      headers,
      method: 'POST',
    });

    expect(first.status).toBe(202);
    await expect(first.json()).resolves.toMatchObject({
      jobCreated: true,
      status: 'queued',
    });
    await expect(duplicate.json()).resolves.toMatchObject({
      deliveryAccepted: false,
      status: 'duplicate',
    });
    expect(database.countJobs()).toBe(1);
    expect(queuedHeads).toEqual(['a'.repeat(40)]);
  });

  it('persists a lifecycle cancellation before notifying the worker', async () => {
    const cancelledActions: string[] = [];
    const { database, url } = await startServer({
      onPullRequestCancelled: (cancellation) => {
        cancelledActions.push(cancellation.action);
        expect(database.claimNextJob()).toBeUndefined();
      },
    });
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'delivery-1',
      headSha: 'a'.repeat(40),
      installationId: 42,
      policyVersion: 'v2',
      pullRequestNumber: 7,
      repository: 'example/project',
    });
    const body = webhookBody('closed');
    const response = await fetch(`${url}/webhooks/github`, {
      body: body.toString('utf8'),
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-2',
        'x-github-event': 'pull_request',
        'x-hub-signature-256': createWebhookSignature(body, secret),
      },
      method: 'POST',
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      jobsCancelled: 1,
      status: 'cancelled',
    });
    expect(cancelledActions).toEqual(['closed']);
  });

  it('routes a fixed pull request command after signature verification', async () => {
    const commands: string[] = [];
    const { url } = await startServer({
      onManualCommand: (command) => {
        commands.push(command.command);
        return Promise.resolve({ status: 'completed' });
      },
    });
    const body = commandBody();
    const response = await fetch(`${url}/webhooks/github`, {
      body: body.toString('utf8'),
      headers: {
        'content-type': 'application/json',
        'x-github-delivery': 'delivery-command-1',
        'x-github-event': 'issue_comment',
        'x-hub-signature-256': createWebhookSignature(body, secret),
      },
      method: 'POST',
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: 'completed' });
    expect(commands).toEqual(['status']);
  });
});
