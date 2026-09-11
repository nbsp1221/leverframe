import type { OpenAPIHono } from '@hono/zod-openapi';
import type { CredentialStore } from '../../github/credentials.js';
import type { JobDatabase } from '../../jobs/database.js';
import type { ServerConfig } from '../config.js';
import {
  convertGitHubManifestCode,
  createGitHubManifestRegistration,
} from '../../github/manifest.js';
import { decideWebhook, verifyWebhookSignature } from '../../github/webhook.js';
import { type Dependency, type Observation, type ServerHooks, json } from '../server-common.js';

const maximumWebhookBytes = 2 * 1024 * 1024;

async function readWebhookBody(request: Request): Promise<Buffer> {
  const contentLength = request.headers.get('content-length');
  if (
    contentLength !== null &&
    Number.isFinite(Number(contentLength)) &&
    Number(contentLength) > maximumWebhookBytes
  ) {
    throw new Error('webhook body is too large');
  }
  if (request.body === null) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const chunk = Buffer.from(next.value);
      length += chunk.length;
      if (length > maximumWebhookBytes) {
        await reader.cancel('webhook body is too large');
        throw new Error('webhook body is too large');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function escapeAttribute(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export function registerGitHubRoutes(
  app: OpenAPIHono,
  config: ServerConfig,
  database: JobDatabase,
  credentials: CredentialStore,
  hooks: ServerHooks,
  observed: (dependency: Dependency, status: Observation['status'], detail?: string | null) => void,
): void {
  const registration = createGitHubManifestRegistration(
    config.uiBaseUrl,
    config.webhookUrl,
    config.githubAppName,
  );
  app.get('/healthz', async (c) => {
    if (new URL(c.req.url).search !== '') {
      return c.notFound();
    }
    try {
      const workerRunning = (await hooks.isWorkerRunning?.()) ?? true;
      const sandboxAvailable = (await hooks.isSandboxAvailable?.()) ?? true;
      const databaseAvailable = database.isAvailable();
      observed(
        'worker',
        hooks.isWorkerRunning === undefined ? 'unknown' : workerRunning ? 'healthy' : 'degraded',
        hooks.isWorkerRunning === undefined
          ? 'no worker heartbeat observed'
          : workerRunning
            ? null
            : 'worker is not running',
      );
      observed(
        'sandbox',
        hooks.isSandboxAvailable === undefined
          ? 'unknown'
          : sandboxAvailable
            ? 'healthy'
            : 'degraded',
        hooks.isSandboxAvailable === undefined
          ? 'no sandbox observation'
          : sandboxAvailable
            ? null
            : 'sandbox is unavailable',
      );
      observed(
        'database',
        databaseAvailable ? 'healthy' : 'unavailable',
        databaseAvailable ? null : 'database is unavailable',
      );
      observed('api', 'healthy');
      const healthy = workerRunning && sandboxAvailable && databaseAvailable;
      return json(c, { status: healthy ? 'ok' : 'unhealthy' }, healthy ? 200 : 503);
    } catch {
      observed('api', 'degraded');
      return json(c, { status: 'unhealthy' }, 503);
    }
  });

  app.get('/setup/github', (c) => {
    if (new URL(c.req.url).search !== '') {
      return c.notFound();
    }
    if (credentials.exists()) {
      return c.html('<h1>GitHub App is already registered</h1>', 409);
    }
    return c.html(
      `<!doctype html><html><body><h1>Register ${escapeAttribute(config.githubAppName)}</h1><form method="post" action="https://github.com/settings/apps/new?state=${registration.state}"><input type="hidden" name="manifest" value="${escapeAttribute(registration.manifest)}"><button type="submit">Create GitHub App</button></form></body></html>`,
    );
  });

  app.get('/setup/github/callback', async (c) => {
    if (!new URL(c.req.url).search) {
      return c.notFound();
    }
    if (credentials.exists()) {
      return c.html('<h1>GitHub App is already registered</h1>', 409);
    }
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (code === undefined || state !== registration.state) {
      return c.html('<h1>Invalid GitHub manifest callback</h1>', 400);
    }
    const converted = await convertGitHubManifestCode(code);
    credentials.write(converted);
    return c.html(
      `<h1>GitHub App registered</h1><p>Credentials were stored locally.</p><p><a href="https://github.com/apps/${encodeURIComponent(converted.slug)}/installations/new">Install the GitHub App</a></p>`,
      201,
    );
  });

  app.post('/webhooks/github', async (c) => {
    if (new URL(c.req.url).search !== '') {
      return json(c, { error: 'not found' }, 404);
    }
    try {
      const body = await readWebhookBody(c.req.raw);
      if (!credentials.exists()) {
        return json(c, { error: 'GitHub App is not registered' }, 503);
      }
      const githubAppCredentials = credentials.read();
      const signature = c.req.header('x-hub-signature-256');
      if (!verifyWebhookSignature(body, signature, githubAppCredentials.webhookSecret)) {
        return json(c, { error: 'invalid signature' }, 401);
      }
      const deliveryId = c.req.header('x-github-delivery');
      const event = c.req.header('x-github-event');
      if (deliveryId === undefined || event === undefined) {
        return json(c, { error: 'missing GitHub headers' }, 400);
      }
      observed('github', 'healthy', 'webhook signature accepted');
      const decision = decideWebhook({
        allowedOwnerId: config.allowedOwnerId,
        body,
        deliveryId,
        event,
        githubAppSlug: githubAppCredentials.slug,
      });
      if (decision.kind === 'ignore') {
        return json(c, decision, 202);
      }
      if (decision.kind === 'cancel') {
        const result = database.cancelPullRequest(decision.cancellation);
        if (result.deliveryAccepted) {
          hooks.onPullRequestCancelled?.(decision.cancellation);
        }
        return json(
          c,
          {
            deliveryAccepted: result.deliveryAccepted,
            jobsCancelled: result.jobsCancelled,
            status: result.deliveryAccepted ? 'cancelled' : 'duplicate',
          },
          202,
        );
      }
      if (decision.kind === 'command') {
        if (hooks.onManualCommand === undefined) {
          return json(c, { status: 'command handling unavailable' }, 202);
        }
        return json(c, await hooks.onManualCommand(decision.command), 202);
      }
      const result = database.enqueuePullRequest(decision.job);
      if (result.jobCreated) {
        hooks.onJobQueued?.(decision.job);
      }
      return json(
        c,
        {
          deliveryAccepted: result.deliveryAccepted,
          jobCreated: result.jobCreated,
          jobsSuperseded: result.jobsSuperseded,
          status: result.jobCreated ? 'queued' : 'duplicate',
        },
        202,
      );
    } catch (error) {
      return json(c, { error: error instanceof Error ? error.message : 'unknown error' }, 400);
    }
  });
}
