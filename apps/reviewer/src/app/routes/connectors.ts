import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MiddlewareHandler } from 'hono';
import { type OpenAPIHono, z } from '@hono/zod-openapi';
import {
  connectorHealthSchema,
  connectorMaximumResultBytes,
  connectorResultSchema,
} from '@repo/contracts/connectors';
import { decisionCreateSchema } from '@repo/contracts/decisions';
import { bodyLimit } from 'hono/body-limit';
import type { ConnectorRuntime } from '../../connectors/runtime.js';
import { DecisionConflict, type DecisionService } from '../../decisions/service.js';
import type { DecisionRegistration } from './decisions.js';

const connectorBodyLimit: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: c.req.path.startsWith('/api/v1/connectors/agent/results/')
      ? connectorMaximumResultBytes
      : 1024 * 1024,
  })(c, next);

export function registerConnectorRoutes(
  app: OpenAPIHono,
  runtime?: ConnectorRuntime,
  service?: DecisionService,
  registration?: DecisionRegistration,
) {
  app.use('/api/v1/connectors/*', connectorBodyLimit);
  app.use('/api/v1/connectors/*', async (c, next) => {
    if (!runtime || !service || !registration) {
      return c.json({ error: 'not_configured' }, 503);
    }
    // Browser writes require same origin; terminal enrollment and scoped connector traffic use separate endpoints.
    if (
      c.req.method !== 'GET' &&
      !c.req.path.includes('/agent/') &&
      !c.req.path.endsWith('/enroll')
    ) {
      if (c.req.header('authorization')) {
        return c.json({ error: 'user_action_required' }, 403);
      }
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) {
        return c.json({ error: 'origin_rejected' }, 403);
      }
      if (!c.req.header('content-type')?.startsWith('application/json')) {
        return c.json({ error: 'json_required' }, 415);
      }
    }
    await next();
  });
  app.get('/api/v1/connectors', (c) =>
    runtime ? c.json({ items: runtime.store.list() }) : c.json({ error: 'not_configured' }, 503),
  );
  app.post('/api/v1/connectors/pairings', (c) => c.json(runtime!.store.pair()));
  app.get('/api/v1/connectors/pairings/:id', (c) => {
    const pairing = runtime!.store.pairing(c.req.param('id'));
    return pairing ? c.json(pairing) : c.json({ error: 'not_found' }, 404);
  });
  app.post('/api/v1/connectors/enroll', async (c) => {
    const parsed = z
      .object({
        code: z.string().min(20).max(100),
        name: z.string().trim().min(1).max(100),
        hostname: z.string().trim().min(1).max(200),
      })
      .strict()
      .safeParse(await c.req.json());
    if (!parsed.success) {
      return c.json({ error: 'invalid_enrollment' }, 422);
    }
    try {
      const identity = runtime!.store.enroll(
        parsed.data.code,
        parsed.data.name,
        parsed.data.hostname,
      );
      runtime!.attach(identity.id);
      return c.json(identity);
    } catch {
      return c.json({ error: 'pairing_expired_or_used' }, 409);
    }
  });
  app.post('/api/v1/connectors/:id/revoke', (c) => {
    runtime!.revoke(c.req.param('id'));
    return c.json({ ok: true });
  });

  const agentId = (header: string | undefined) =>
    header?.startsWith('Bearer ') ? runtime!.store.authenticate(header.slice(7)) : undefined;

  app.post('/api/v1/connectors/agent/status', (c) => {
    const id = agentId(c.req.header('authorization'));
    return id ? c.json({ id }) : c.json({ error: 'unauthorized' }, 401);
  });
  app.post('/api/v1/connectors/agent/poll', async (c) => {
    const id = agentId(c.req.header('authorization'));
    if (!id) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const health = connectorHealthSchema.safeParse(await c.req.json());
    if (!health.success) {
      return c.json({ error: 'invalid_health' }, 422);
    }
    runtime!.store.heartbeat(id, health.data);
    return c.json({ commands: runtime!.store.claim(id) });
  });
  app.post('/api/v1/connectors/agent/authorize/:id', (c) => {
    const id = agentId(c.req.header('authorization'));
    if (!id || !runtime!.store.canExecute(id, c.req.param('id'))) {
      return c.json({ error: 'command_no_longer_authorized' }, 403);
    }
    return c.json({ ok: true });
  });
  app.post('/api/v1/connectors/agent/results/:id', async (c) => {
    const id = agentId(c.req.header('authorization'));
    if (!id) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const result = connectorResultSchema.safeParse(await c.req.json());
    if (!result.success) {
      return c.json({ error: 'invalid_result' }, 422);
    }
    runtime!.store.complete(id, c.req.param('id'), result.data);
    return c.json({ ok: true });
  });
  app.post('/api/v1/connectors/agent/questions', async (c) => {
    const id = agentId(c.req.header('authorization'));
    if (!id) {
      return c.json({ error: 'unauthorized' }, 401);
    }
    const input = z
      .object({
        sessionId: z.string().min(1).max(200),
        cwd: z.string().refine(isAbsolute),
        question: z.record(z.string(), z.unknown()),
      })
      .strict()
      .safeParse(await c.req.json());
    if (
      !input.success ||
      ['source', 'threadId'].some((key) => key in (input.success ? input.data.question : {}))
    ) {
      return c.json({ error: 'invalid_source' }, 422);
    }
    const question = decisionCreateSchema.safeParse({
      ...input.data.question,
      source: { connectionId: id, sessionId: input.data.sessionId },
    });
    if (!question.success) {
      return c.json({ error: 'invalid_question' }, 422);
    }
    try {
      runtime!.bind(id, input.data.sessionId, input.data.cwd);
      const item = await service!.create(question.data, registration!.resolve);
      runtime!.store.recordQuestion(id);
      return c.json(item);
    } catch (error) {
      return c.json(
        { error: error instanceof DecisionConflict ? error.message : 'agent_unavailable' },
        error instanceof DecisionConflict ? 409 : 503,
      );
    }
  });
  // Fixed artifact allowlist; the endpoint never exposes config, source trees or credentials.
  app.get('/api/v1/connectors/download/:file', (c) => {
    const file = c.req.param('file');
    if (!['install.sh', 'connector.tar.gz'].includes(file)) {
      return c.json({ error: 'not_found' }, 404);
    }
    try {
      const root =
        process.env.LEVERFRAME_CONNECTOR_ARTIFACTS ??
        fileURLToPath(new URL('./connector/', import.meta.url));
      const bytes = readFileSync(`${root}/${file}`);
      c.header(
        'content-type',
        file.endsWith('.sh') ? 'text/plain; charset=utf-8' : 'application/gzip',
      );
      c.header('cache-control', 'no-store');
      return c.body(bytes);
    } catch {
      return c.json({ error: 'connector_bundle_unavailable' }, 503);
    }
  });
}
