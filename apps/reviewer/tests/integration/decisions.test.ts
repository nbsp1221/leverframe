import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenAPIHono } from '@hono/zod-openapi';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentGateway, AnswerDelivery } from '../../src/decisions/ports.js';
import { registerDecisionRoutes } from '../../src/app/routes/decisions.js';
import { DecisionConflict, DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';
import { decisionFixtures } from '../fixtures/decisions.js';

const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close();
  }
});

function setup(path = ':memory:') {
  const repository = new SqliteDecisionRepository(path);
  cleanup.push(() => repository.close());
  for (const fixture of decisionFixtures('2026-10-04T00:00:00.000Z')) {
    repository.insert(fixture);
  }
  const sent: AnswerDelivery[] = [];
  let state: 'ready' | 'offline' | 'superseded' = 'ready';
  const agent: AgentGateway = {
    inspect: () => Promise.resolve(state),
    deliver: (command) => {
      sent.push(command);
      return Promise.resolve();
    },
  };
  const service = new DecisionService(repository, agent, () => '2026-10-04T00:00:00.000Z');
  return {
    repository,
    service,
    sent,
    setState: (next: typeof state) => {
      state = next;
    },
  };
}

const answer = {
  id: 'answer-1',
  expectedRevision: 0,
  intent: 'decide' as const,
  optionId: 'preserve',
  text: '',
};

describe('decision ownership through real storage and application policy', () => {
  it('stores an answer before delivery and never treats a transport receipt as application', async () => {
    const { service, sent } = setup();
    service.answer('dr-101', answer);
    expect(service.get('dr-101').status).toBe('queued');
    expect(sent).toHaveLength(0);
    await service.dispatch('dr-101');
    expect(service.get('dr-101').status).toBe('delivered');
    expect(sent[0]?.context.threadId).toBe('preview-dr-101');
    expect(sent[0]?.constraints).toEqual(service.get('dr-101').constraints);
    service.recordOutcome({
      id: 'receipt-1',
      decisionId: 'dr-101',
      answerId: answer.id,
      taskRevision: '1',
      kind: 'applied',
      text: 'Kept normal accounts visible; total is provisional.',
    });
    expect(service.get('dr-101').status).toBe('applied');
  });

  it('deduplicates lost-response retries and rejects another tab answering an old revision', async () => {
    const { service, sent } = setup();
    service.answer('dr-101', answer);
    service.answer('dr-101', answer);
    expect(() => service.answer('dr-101', { ...answer, id: 'other-tab' })).toThrow(
      DecisionConflict,
    );
    expect(() => service.answer('dr-101', { ...answer, text: 'changed' })).toThrow(
      DecisionConflict,
    );
    await Promise.all([service.dispatch('dr-101'), service.dispatch('dr-101')]);
    expect(sent).toHaveLength(1);
    expect(service.get('dr-101').answers).toHaveLength(1);
  });

  it('keeps research unresolved, preserves history, and rejects late results from an earlier answer', async () => {
    const { service } = setup();
    service.answer('dr-101', {
      id: 'research-1',
      expectedRevision: 0,
      intent: 'research',
      text: 'Compare with main first.',
    });
    await service.dispatch('dr-101');
    const event = {
      id: 'research-start',
      decisionId: 'dr-101',
      answerId: 'research-1',
      taskRevision: '1',
    };
    expect(() => service.recordOutcome({ ...event, kind: 'applied', text: 'Implemented' })).toThrow(
      'research_is_not_approval',
    );
    service.recordOutcome({ ...event, kind: 'investigating', text: 'Comparing' });
    service.recordOutcome({
      ...event,
      id: 'research-result',
      kind: 'needs_input',
      text: 'Here are the differences',
    });
    const current = service.get('dr-101');
    expect(current.status).toBe('awaiting_answer');
    service.answer('dr-101', { ...answer, expectedRevision: current.revision });
    await service.dispatch('dr-101');
    expect(() =>
      service.recordOutcome({ ...event, id: 'late', kind: 'applied', text: 'Old work' }),
    ).toThrow('stale_agent_outcome');
    expect(service.get('dr-101').answers).toHaveLength(2);
  });

  it('retains the original answer when offline and retries with the same delivery identity', async () => {
    const { service, setState, sent } = setup();
    service.answer('dr-101', answer);
    setState('offline');
    await service.dispatch('dr-101');
    const failed = service.get('dr-101');
    expect(failed.status).toBe('delivery_failed');
    expect(sent).toHaveLength(0);
    setState('ready');
    service.retry(failed.id, failed.revision);
    await service.dispatch(failed.id);
    expect(sent[0]?.id).toBe('dr-101:answer-1');
    expect(service.get(failed.id).answers).toHaveLength(1);
  });

  it('never delivers an old decision to a superseded task', async () => {
    const { service, setState, sent } = setup();
    service.answer('dr-101', answer);
    setState('superseded');
    await service.dispatch('dr-101');
    expect(service.get('dr-101').status).toBe('superseded');
    expect(sent).toHaveLength(0);
    expect(() => service.answer('dr-104', { ...answer, expectedRevision: 1 })).toThrow(
      DecisionConflict,
    );
  });

  it('reopens a durable pending answer after a process/store restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'decision-restart-'));
    const path = join(directory, 'state.sqlite');
    const first = setup(path);
    first.service.answer('dr-101', answer);
    cleanup.pop()?.();
    const second = setup(path);
    expect(second.service.get('dr-101').status).toBe('queued');
    await second.service.dispatch('dr-101');
    expect(second.sent).toHaveLength(1);
    cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  });

  it('persists snoozing without answering, authorizing or dispatching work', async () => {
    const { service, sent, repository } = setup();
    const snoozed = service.snooze('dr-101', 0, true);
    expect(snoozed.status).toBe('awaiting_answer');
    expect(snoozed.answers).toEqual([]);
    expect(Date.parse(snoozed.snoozedUntil!) - Date.parse(snoozed.updatedAt)).toBe(3600000);
    const reopened = new DecisionService(repository, {
      inspect: () => Promise.resolve('ready'),
      deliver: () => {
        throw new Error('Snoozing must not deliver anything');
      },
    });
    expect(reopened.get('dr-101').snoozedUntil).toBe(snoozed.snoozedUntil);
    await reopened.dispatch('dr-101');
    expect(sent).toEqual([]);
    expect(() => service.snooze('dr-101', 0, false)).toThrow(DecisionConflict);
    const awake = service.snooze('dr-101', snoozed.revision, false);
    expect(awake.snoozedUntil).toBeNull();
    expect(awake.answers).toEqual([]);
    expect(() => service.snooze('dr-104', 1, true)).toThrow(DecisionConflict);
  });

  it('exposes the same application policy through the HTTP boundary', async () => {
    const { service, sent } = setup();
    const app = new OpenAPIHono();
    registerDecisionRoutes(app, service);
    const response = await app.request('/api/v1/decisions/dr-101/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(answer),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'queued' });
    expect(sent).toHaveLength(0);
    const conflict = await app.request('/api/v1/decisions/dr-101/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...answer, id: 'second' }),
    });
    expect(conflict.status).toBe(409);
    const invalid = await app.request('/api/v1/decisions/dr-102/answers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...answer, optionId: undefined, text: '  ' }),
    });
    expect(invalid.status).toBeGreaterThanOrEqual(400);
  });
});
