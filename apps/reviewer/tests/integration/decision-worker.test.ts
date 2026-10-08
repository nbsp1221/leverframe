import { afterEach, expect, it } from 'vitest';
import { AgentDeliveryError } from '../../src/decisions/ports.js';
import { DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';
import { DecisionDeliveryWorker } from '../../src/decisions/worker.js';
import { decisionFixtures } from '../fixtures/decisions.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const repositories: SqliteDecisionRepository[] = [];
afterEach(() => {
  for (const repository of repositories.splice(0)) {
    repository.close();
  }
});

function setup(deliver: (id: string) => Promise<void>, concurrency = 4) {
  const repository = new SqliteDecisionRepository(':memory:');
  repositories.push(repository);
  const service = new DecisionService(repository, {
    inspect: () => Promise.resolve('ready'),
    deliver: (item) => deliver(item.decisionId),
  });
  let now = 0;
  const worker = new DecisionDeliveryWorker(
    service,
    (item) => item.context.threadId,
    () => {},
    () => now,
    concurrency,
  );

  const add = (id: string, session = id) => {
    const template = decisionFixtures()[0]!;
    repository.insert({ ...template, id, context: { ...template.context, threadId: session } });
    service.answer(id, {
      id: `answer-${id}`,
      expectedRevision: 0,
      intent: 'decide',
      text: 'Synthetic answer',
    });
  };

  return {
    service,
    worker,
    add,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

it('starts another session while an earlier target is waiting, without duplicate dispatch', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const f = setup(async (id) => {
    calls.push(id);
    if (id === 'slow') {
      await gate.promise;
    }
  });
  f.add('slow');
  f.add('fast');
  const first = f.worker.tick();
  const repeated = f.worker.tick();
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(['slow', 'fast']);
  expect(f.service.get('fast').status).toBe('delivered');
  gate.resolve();
  await Promise.all([first, repeated]);
  await f.worker.close();
});

it('preserves same-session order and applies a bounded retry delay, with explicit retry available', async () => {
  const calls: string[] = [];
  let offline = true;
  const f = setup((id) => {
    calls.push(id);
    return id === 'first' && offline
      ? Promise.reject(new AgentDeliveryError('offline'))
      : Promise.resolve();
  });
  f.add('first', 'same');
  f.add('second', 'same');
  f.add('other');
  await f.worker.tick();
  await f.worker.tick();
  expect(calls).toEqual(['first', 'other']);
  f.advance(2000);
  await f.worker.tick();
  expect(calls).toEqual(['first', 'other', 'first']);
  offline = false;
  f.service.retry('first', f.service.get('first').revision);
  await f.worker.tick();
  await f.worker.tick();
  expect(calls).toEqual(['first', 'other', 'first', 'first', 'second']);
  await f.worker.close();
});

it('bounds simultaneous attempts and does not start new work after shutdown', async () => {
  const gate = deferred();
  const calls: string[] = [];
  const f = setup(async (id) => {
    calls.push(id);
    await gate.promise;
  }, 2);
  for (const id of ['a', 'b', 'c']) {
    f.add(id);
  }
  const tick = f.worker.tick();
  await Promise.resolve();
  expect(calls).toEqual(['a', 'b']);
  const stopped = f.worker.close();
  gate.resolve();
  await Promise.all([tick, stopped]);
  await f.worker.tick();
  expect(calls).toEqual(['a', 'b']);
  expect(f.service.get('c').status).toBe('queued');
});
