import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentConnection } from '../../src/agent-connections/ports.js';
import { registerConnectorRoutes } from '../../src/app/routes/connectors.js';
import { validateCoreUrl } from '../../src/connectors/client.js';
import { ConnectorRuntime } from '../../src/connectors/runtime.js';
import { ConnectorStore } from '../../src/connectors/store.js';
import { SessionDecisionGateway } from '../../src/decisions/delivery.js';
import { DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';
import { decisionFixtures } from '../fixtures/decisions.js';
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});

const createStore = (path = ':memory:', now = Date.now) => {
  const store = new ConnectorStore(path, now);
  cleanup.push(() => store.close());
  return store;
};

const enroll = (store: ConnectorStore) => {
  const pair = store.pair();
  return store.enroll(pair.code, 'Computer', 'host');
};

describe('computer enrollment and durable routing', () => {
  it('expires and consumes codes once, keeps secrets out of status, and revokes authorization', () => {
    let now = 1_000;
    const store = createStore(':memory:', () => now);
    const expired = store.pair();
    now += 600_001;
    expect(() => store.enroll(expired.code, 'n', 'h')).toThrow('pairing_expired_or_used');
    const code = store.pair();
    const identity = store.enroll(code.code, 'Computer', 'host');
    expect(() => store.enroll(code.code, 'Other', 'host')).toThrow();
    expect(store.authenticate(identity.token)).toBe(identity.id);
    expect(store.authenticate('wrong')).toBeUndefined();
    expect(JSON.stringify(store.list())).not.toContain(identity.token);
    store.heartbeat(identity.id, { codex: 'ready', skill: 'installed' });
    expect(store.list()[0]?.status).toBe('online');
    now += 16_000;
    expect(store.list()[0]?.status).toBe('offline');
    store.revoke(identity.id);
    expect(store.authenticate(identity.token)).toBeUndefined();
    expect(store.list()[0]?.status).toBe('revoked');
  });
  it('preserves auto-bound sessions and claimed sends across restarts without reissuing commands', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-connector-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const file = join(root, 'state.sqlite');
    const store = new ConnectorStore(file);
    const one = enroll(store);
    const two = enroll(store);
    store.bind(one.id, 'same-id', '/first');
    store.bind(two.id, 'same-id', '/second');
    expect(() => store.bind(one.id, 'same-id', '/other')).toThrow('session_identity_changed');
    const key = store.enqueue(
      one.id,
      { kind: 'send', sessionId: 'same-id', cwd: '/first', message: 'answer', revision: 'turn-1' },
      60_000,
    );
    expect(store.claim(two.id)).toHaveLength(0);
    expect(store.claim(one.id)).toHaveLength(1);
    store.close();
    const reopened = createStore(file);
    expect(reopened.sessions(one.id).get('same-id')).toBe('/first');
    expect(reopened.authenticate(one.token)).toBe(one.id);
    expect(reopened.claim(one.id)).toHaveLength(0);
    reopened.complete(two.id, key, { ok: true });
    expect(reopened.result(key)).toBeUndefined();
    reopened.complete(one.id, key, { ok: true });
    expect(reopened.result(key)).toEqual({ ok: true });
  });
  it('does not execute expired or revoked pending commands', () => {
    let now = 1000;
    const store = createStore(':memory:', () => now);
    const one = enroll(store);
    store.enqueue(one.id, { kind: 'send', sessionId: 's', cwd: '/w', message: 'answer' }, 100);
    now += 101;
    expect(store.claim(one.id)).toHaveLength(0);
    store.enqueue(one.id, { kind: 'read', sessionId: 's', cwd: '/w' }, 1000);
    store.revoke(one.id);
    expect(store.claim(one.id)).toHaveLength(0);
  });
  it('accepts a new session through the connector identity and keeps delivery policy unchanged', async () => {
    const store = createStore();
    const identity = enroll(store);
    const connections = new Map<string, AgentConnection>();
    const runtime = new ConnectorRuntime(store, connections);
    cleanup.push(() => runtime.stop());
    const repository = new SqliteDecisionRepository(':memory:');
    cleanup.push(() => repository.close());
    const gateway = new SessionDecisionGateway(connections, repository, 'legacy');
    const service = new DecisionService(repository, gateway);
    const app = new OpenAPIHono();
    registerConnectorRoutes(app, runtime, service, {
      token: 'legacy',
      resolve: (session, id) => gateway.resolve(session, id),
    });
    let revision = 'turn-1';
    const messages: string[] = [];
    let sendCount = 0;
    const worker = setInterval(() => {
      for (const command of store.claim(identity.id)) {
        if (command.kind === 'prepare') {
          store.complete(identity.id, command.id, { ok: true, preparedId: 'prepared' });
        } else if (command.kind === 'close') {
          store.complete(identity.id, command.id, { ok: true });
        } else if (command.kind === 'send') {
          expect(command.revision).toBe('turn-1');
          messages.push(command.message!);
          revision = 'turn-2';
          sendCount++;
          store.complete(identity.id, command.id, { ok: true });
        } else {
          store.complete(identity.id, command.id, {
            ok: true,
            snapshot: { revision, state: 'ready', messages: [...messages] },
          });
        }
      }
    }, 5);
    cleanup.push(() => clearInterval(worker));
    const sample = decisionFixtures()[0]!;
    const question = {
      key: 'first',
      project: sample.project,
      title: sample.title,
      goal: sample.goal,
      question: sample.question,
      why: sample.why,
      mode: sample.mode,
      waitingFor: sample.waitingFor,
      continuing: sample.continuing,
      assumption: sample.assumption,
      constraints: sample.constraints,
      facts: sample.facts,
      options: sample.options,
      recommendation: sample.recommendation,
    };

    const post = (path: string, body: unknown, token = identity.token) =>
      app.request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    expect(
      (
        await post(
          '/api/v1/connectors/agent/questions',
          { sessionId: 'new-session', cwd: '/new-worktree', question },
          'wrong',
        )
      ).status,
    ).toBe(401);
    const response = await post('/api/v1/connectors/agent/questions', {
      sessionId: 'new-session',
      cwd: '/new-worktree',
      question,
    });
    expect(response.status).toBe(200);
    const item = (await response.json()) as { id: string; context: { connectionId: string } };
    expect(item.context.connectionId).toBe(identity.id);
    expect(store.sessions(identity.id).get('new-session')).toBe('/new-worktree');
    service.answer(item.id, {
      id: 'answer',
      expectedRevision: 0,
      intent: 'decide',
      optionId: sample.options[0]!.id,
      text: '',
    });
    await service.dispatch(item.id);
    await service.dispatch(item.id);
    expect(sendCount).toBe(1);
    expect(service.get(item.id).status).toBe('delivered');
    // A long existing conversation must not be rejected by the smaller question-body limit.
    const read = store.enqueue(
      identity.id,
      { kind: 'read', sessionId: 'new-session', cwd: '/new-worktree' },
      1000,
    );
    store.claim(identity.id);
    const longSnapshot = {
      revision: 'turn-2',
      state: 'ready',
      messages: ['x'.repeat(2 * 1024 * 1024)],
    };
    expect(
      (await post(`/api/v1/connectors/agent/results/${read}`, { ok: true, snapshot: longSnapshot }))
        .status,
    ).toBe(200);
    expect(store.result(read)).toEqual({ ok: true, snapshot: longSnapshot });
    expect(
      (
        await post('/api/v1/connectors/agent/questions', {
          sessionId: 'new-session',
          cwd: '/new-worktree',
          question,
        })
      ).status,
    ).toBe(200);
    // Agent credential cannot enroll other machines or revoke a computer through admin routes.
    expect((await post('/api/v1/connectors/pairings', {})).status).toBe(403);
    expect(
      (
        await app.request('/api/v1/connectors/pairings', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'origin': 'https://other.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('restores auto-bound routes without static connection configuration', () => {
    const store = createStore();
    const identity = enroll(store);
    store.bind(identity.id, 'session', '/project');
    const connections = new Map<string, AgentConnection>();
    const runtime = new ConnectorRuntime(store, connections);
    cleanup.push(() => runtime.stop());
    expect(connections.get(identity.id)?.sessions.get('session')).toBe('/project');
    runtime.revoke(identity.id);
    expect(connections.has(identity.id)).toBe(true);
  });
  it('rejects public plaintext and credential-bearing core URLs', () => {
    expect(validateCoreUrl('http://127.0.0.1:1234')).toBe('http://127.0.0.1:1234');
    expect(validateCoreUrl('http://100.80.0.1:1234')).toBe('http://100.80.0.1:1234');
    expect(() => validateCoreUrl('http://example.com')).toThrow();
    expect(() => validateCoreUrl('http://10.evil.test')).toThrow();
    expect(() => validateCoreUrl('http://100.80.fake.test')).toThrow();
    expect(() => validateCoreUrl('https://user:secret@example.com')).toThrow();
    expect(() => validateCoreUrl('https://example.com?token=secret')).toThrow();
  });
});

it('reconciles an accepted send with a lost connector reply without executing it twice', async () => {
  const store = createStore();
  const identity = enroll(store);
  const connections = new Map<string, AgentConnection>();
  const runtime = new ConnectorRuntime(store, connections, { query: 500, execution: 300 });
  cleanup.push(() => runtime.stop());
  const repository = new SqliteDecisionRepository(':memory:');
  cleanup.push(() => repository.close());
  const item = {
    ...decisionFixtures()[0]!,
    context: {
      connectionId: identity.id,
      agentId: 'codex',
      threadId: 's',
      taskId: 't',
      taskRevision: 't',
    },
  };
  repository.insert(item);
  runtime.bind(identity.id, 's', '/work');
  const service = new DecisionService(
    repository,
    new SessionDecisionGateway(connections, repository, 'legacy'),
  );
  const messages: string[] = [];
  let sends = 0;
  const worker = setInterval(() => {
    for (const cmd of store.claim(identity.id)) {
      if (cmd.kind === 'send') {
        messages.push(cmd.message!);
        sends++;
        continue;
      }
      store.complete(
        identity.id,
        cmd.id,
        cmd.kind === 'prepare'
          ? { ok: true, preparedId: cmd.id }
          : cmd.kind === 'read'
            ? {
                ok: true,
                snapshot: {
                  revision: messages.length ? 'answer-turn' : 't',
                  state: 'ready',
                  messages: [...messages],
                },
              }
            : { ok: true },
      );
    }
  }, 5);
  cleanup.push(() => clearInterval(worker));
  service.answer(item.id, {
    id: 'answer',
    expectedRevision: 0,
    intent: 'decide',
    optionId: item.options[0]!.id,
    text: '',
  });
  await service.dispatch(item.id);
  expect(service.get(item.id).deliveryIssue).toBe('unconfirmed');
  await service.dispatch(item.id);
  expect(service.get(item.id).status).toBe('delivered');
  expect(sends).toBe(1);
});

it('preserves old request identities and locks while replacing the static route with a persisted connector alias', () => {
  const root = mkdtempSync(join(tmpdir(), 'lf-connector-migration-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'inbox.sqlite');
  const repository = new SqliteDecisionRepository(path, 'legacy');
  cleanup.push(() => repository.close());
  const store = createStore(path);
  const identity = enroll(store);
  store.bind(identity.id, 'session', '/work');
  const item = {
    ...decisionFixtures()[0]!,
    context: {
      connectionId: 'legacy',
      agentId: 'codex',
      threadId: 'session',
      taskId: 'turn',
      taskRevision: 'turn',
    },
  };
  repository.create(item, 'original-hash');
  repository.reserveDelivery('uncertain', 'original-message-hash');
  repository.acquireSession(JSON.stringify(['legacy', 'session']), 'uncertain');
  store.adoptLegacy('legacy', identity.id);
  expect(repository.get(item.id)).toEqual(item);
  expect(repository.creationHash(item.id)).toBe('original-hash');
  expect(repository.deliveryReserved('uncertain')).toBe(true);
  expect(repository.acquireSession(JSON.stringify([identity.id, 'session']), 'different')).toBe(
    false,
  );
  const connections = new Map<string, AgentConnection>();
  const runtime = new ConnectorRuntime(store, connections);
  cleanup.push(() => runtime.stop());
  expect(connections.get('legacy')).toBe(connections.get(identity.id));
  runtime.revoke(identity.id);
  const restored = new Map<string, AgentConnection>();
  const after = new ConnectorRuntime(store, restored);
  cleanup.push(() => after.stop());
  expect(restored.get('legacy')).toBeDefined();
});
