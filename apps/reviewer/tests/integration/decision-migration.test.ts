import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentConnection,
  type SessionSnapshot,
  UnsupportedSessionChannel,
} from '../../src/agent-connections/ports.js';
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

function setup() {
  const repository = new SqliteDecisionRepository(':memory:');
  cleanup.push(() => repository.close());
  const item = {
    ...decisionFixtures()[0]!,
    context: {
      connectionId: 'one',
      agentId: 'test',
      threadId: 'opaque-session',
      taskId: 'first',
      taskRevision: 'first',
    },
  };
  repository.insert(item);
  const snapshot: SessionSnapshot = { revision: 'first', state: 'ready', messages: [] };

  let prepare = async () => {};

  let sends = 0;
  const connection: AgentConnection = {
    id: 'one',
    agentId: 'test',
    sessions: new Map([['opaque-session', '/test']]),
    observer: { read: () => Promise.resolve(structuredClone(snapshot)) },
    channel: {
      prepare: async () => {
        await prepare();
        return {
          send: (text) => {
            sends++;
            snapshot.messages = [text];
            snapshot.revision = 'response';
            return Promise.resolve();
          },
          close: async () => {},
        };
      },
    },
  };
  const gateway = new SessionDecisionGateway(new Map([['one', connection]]), repository, 'one');
  const service = new DecisionService(repository, gateway);

  const answer = () =>
    service.answer(item.id, {
      id: 'answer',
      expectedRevision: item.revision,
      text: 'Only inspect',
      intent: 'research',
    });

  return {
    repository,
    item,
    snapshot,
    connection,
    gateway,
    service,
    answer,
    sends: () => sends,
    onPrepare: (fn: () => Promise<void>) => {
      prepare = fn;
    },
  };
}

describe('ACP migration safeguards', () => {
  it('rechecks the checkpoint after loading an adapter and never resumes a cancelled origin', async () => {
    const f = setup();
    f.answer();
    f.onPrepare(() => {
      f.snapshot.revision = 'human-input';
      return Promise.resolve();
    });
    await f.service.dispatch(f.item.id);
    expect(f.sends()).toBe(0);
    expect(f.service.get(f.item.id).status).toBe('superseded');
    const cancelled = setup();
    cancelled.answer();
    cancelled.snapshot.state = 'cancelled';
    await cancelled.service.dispatch(cancelled.item.id);
    expect(cancelled.sends()).toBe(0);
    expect(cancelled.service.get(cancelled.item.id).status).toBe('superseded');
  });
  it('automatically recovers busy targets but reports missing protocol capability', async () => {
    const f = setup();
    f.answer();
    f.snapshot.state = 'busy';
    await f.service.dispatch(f.item.id);
    expect(f.service.get(f.item.id).deliveryIssue).toBe('busy');
    f.snapshot.state = 'ready';
    await f.service.dispatch(f.item.id);
    expect(f.sends()).toBe(1);
    expect(f.service.get(f.item.id).status).toBe('delivered');
    const unsupported = setup();
    unsupported.answer();
    unsupported.onPrepare(() => Promise.reject(new UnsupportedSessionChannel()));
    await unsupported.service.dispatch(unsupported.item.id);
    expect(unsupported.service.get(unsupported.item.id).deliveryIssue).toBe('unsupported');
  });
  it('retains an ambiguous reservation even when the original conversation changes', async () => {
    const f = setup();
    f.answer();
    f.repository.reserveDelivery(`${f.item.id}:answer`, 'unknown-legacy-hash');
    f.snapshot.revision = 'later-turn';
    await f.service.dispatch(f.item.id);
    await f.service.dispatch(f.item.id);
    expect(f.service.get(f.item.id).deliveryIssue).toBe('unconfirmed');
    expect(f.sends()).toBe(0);
  });
  it('namespaces session locks by connection and blocks competing answers until receipt', () => {
    const f = setup();
    expect(f.repository.acquireSession('["one","session"]', 'first')).toBe(true);
    expect(f.repository.acquireSession('["one","session"]', 'second')).toBe(false);
    f.repository.reserveDelivery('first', 'response-hash');
    f.repository.confirmDelivery('first');
    expect(f.repository.deliveryConfirmed('first')).toBe(true);
    expect(f.repository.acquireSession('["one","session"]', 'second')).toBe(true);
    expect(f.repository.acquireSession('["two","session"]', 'second')).toBe(true);
    f.repository.releaseSession('["one","session"]', 'wrong-owner');
    expect(f.repository.acquireSession('["one","session"]', 'third')).toBe(false);
  });
  it('migrates a legacy database without losing identities and blocks old writers', () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-migration-'));
    cleanup.push(() => rmSync(root, { force: true, recursive: true }));
    const path = join(root, 'inbox.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(
      'CREATE TABLE decisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL); CREATE TABLE decision_creations (id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE decision_deliveries (id TEXT PRIMARY KEY, hash TEXT NOT NULL)',
    );
    const item = {
      ...decisionFixtures()[0]!,
      status: 'queued',
      context: {
        agentId: 'codex',
        threadId: 'legacy-session',
        taskId: 'turn',
        taskRevision: 'turn',
      },
      answers: [
        {
          id: 'answer',
          expectedRevision: 0,
          text: 'Keep original scope',
          intent: 'research',
          at: new Date().toISOString(),
        },
      ],
    };
    legacy
      .prepare('INSERT INTO decisions VALUES (?, ?, ?)')
      .run(item.id, item.revision, JSON.stringify(item));
    legacy
      .prepare('INSERT INTO decision_creations VALUES (?, ?)')
      .run(item.id, 'original-creation-hash');
    legacy
      .prepare('INSERT INTO decision_deliveries VALUES (?, ?)')
      .run(`${item.id}:answer`, 'original-delivery-hash');
    legacy.close();
    const migrated = new SqliteDecisionRepository(path, 'desktop');
    expect(migrated.get(item.id)).toEqual({
      ...item,
      context: { ...item.context, connectionId: 'desktop' },
    });
    expect(migrated.creationHash(item.id)).toBe('original-creation-hash');
    expect(migrated.deliveryReserved(`${item.id}:answer`)).toBe(true);
    expect(migrated.acquireSession('["desktop","legacy-session"]', 'different')).toBe(false);
    expect(migrated.reserveDelivery(`${item.id}:answer`, 'original-delivery-hash')).toBe(false);
    migrated.close();
    const reopened = new SqliteDecisionRepository(path, 'desktop');
    reopened.close();
    const oldWriter = new DatabaseSync(path);
    expect(() =>
      oldWriter
        .prepare('UPDATE decisions SET body = ? WHERE id = ?')
        .run(JSON.stringify(item), item.id),
    ).toThrow('requires_connection');
    expect(() =>
      oldWriter
        .prepare('INSERT INTO decision_deliveries VALUES (?, ?, ?)')
        .run('new', 'hash', 'reserved'),
    ).toThrow('legacy_delivery_writer');
    oldWriter.close();
  });
  it('keeps protocol and storage implementations out of application imports', () => {
    for (const file of ['service.ts', 'delivery.ts', 'ports.ts']) {
      const source = readFileSync(new URL(`../../src/decisions/${file}`, import.meta.url), 'utf8');
      const imports = source.match(/(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/g) ?? [];
      expect(imports.join('\n')).not.toMatch(
        /codex|acp-channel|@agentclientprotocol|node:sqlite|child_process|from ['"]ws/,
      );
    }
  });
});

it('keeps identical session keys on different connections as distinct requests', async () => {
  const f = setup();
  const connections = new Map(['one', 'two'].map((id) => [id, { ...f.connection, id }]));
  const gateway = new SessionDecisionGateway(connections, f.repository, 'one');
  const service = new DecisionService(f.repository, gateway);
  const {
    id: _id,
    revision: _revision,
    status: _status,
    context: _context,
    events: _events,
    answers: _answers,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    snoozedUntil: _snoozedUntil,
    ...content
  } = f.item;
  const one = await service.create(
    { ...content, key: 'same', source: { connectionId: 'one', sessionId: 'opaque-session' } },
    (id, connection) => gateway.resolve(id, connection),
  );
  const two = await service.create(
    { ...content, key: 'same', source: { connectionId: 'two', sessionId: 'opaque-session' } },
    (id, connection) => gateway.resolve(id, connection),
  );
  expect(one.id).not.toBe(two.id);
  expect(one.context.connectionId).toBe('one');
  expect(two.context.connectionId).toBe('two');
});
