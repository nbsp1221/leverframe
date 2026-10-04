import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRequestListener } from '@hono/node-server';
import { OpenAPIHono } from '@hono/zod-openapi';
import { decisionCreateSchema, decisionSchema } from '@repo/contracts/decisions';
import { execa } from 'execa';
import { afterEach, describe, expect, it } from 'vitest';
import type { CodexRpc } from '../../src/agent-connections/codex-observer-rpc.js';
import type { AnswerDelivery } from '../../src/decisions/ports.js';
import { CodexSessionObserver } from '../../src/agent-connections/codex-observer.js';
import { registerDecisionRoutes } from '../../src/app/routes/decisions.js';
import { SessionDecisionGateway, answerMessage } from '../../src/decisions/delivery.js';
import { DecisionService } from '../../src/decisions/service.js';
import { SqliteDecisionRepository } from '../../src/decisions/sqlite-repository.js';

const threadId = '00000000-0000-4000-8000-000000000001';
const question = decisionCreateSchema.parse({
  key: 'first',
  threadId,
  project: 'Test',
  title: 'Choose a format',
  goal: 'Show a report',
  question: 'Short or long?',
  why: 'The user has not chosen a format.',
  mode: 'blocking',
  waitingFor: 'Format selection',
  continuing: '',
  assumption: null,
  constraints: ['No file writes'],
  facts: [],
  options: [{ id: 'short', label: 'Short', effect: 'One line', recommended: true }],
  recommendation: 'Short is sufficient',
});
const cleanup: (() => void)[] = [];
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) {
    close();
  }
});

function gateway(rpc: CodexRpc, repository: SqliteDecisionRepository) {
  const sessions = new Map([[threadId, '/test']]);
  return new SessionDecisionGateway(
    new Map([
      [
        'local-codex',
        {
          id: 'local-codex',
          agentId: 'codex',
          sessions,
          observer: new CodexSessionObserver(rpc, sessions),
          channel: {
            prepare: () =>
              Promise.resolve({
                send: async (text) => {
                  await rpc.call('turn/start', { input: [{ type: 'text', text }] });
                },
                close: async () => {},
              }),
          },
        },
      ],
    ]),
    repository,
    'local-codex',
  );
}

function fixture(path = ':memory:') {
  const repository = new SqliteDecisionRepository(path);
  cleanup.push(() => repository.close());
  const thread = {
    id: threadId,
    cwd: '/test',
    canAcceptDirectInput: true,
    turns: [{ id: 'origin-turn', status: 'completed', items: [] as unknown[] }],
  };
  let starts = 0;
  let loseResponse = false;
  let omitReceipt = false;
  const rpc: CodexRpc = {
    call: async (method, params) => {
      await Promise.resolve();
      if (method === 'thread/read') {
        return { thread: structuredClone(thread) };
      }
      if (method === 'thread/loaded/list') {
        return { data: [threadId] };
      }
      if (method === 'turn/start') {
        starts += 1;
        if (!omitReceipt) {
          thread.turns.push({
            id: 'answer-turn',
            status: 'completed',
            items: [{ type: 'userMessage', content: params.input }],
          });
        }
        if (loseResponse) {
          throw new Error('response lost');
        }
        return { turn: { id: 'answer-turn' } };
      }
      throw new Error('unexpected method');
    },
  };
  const agent = gateway(rpc, repository);
  const service = new DecisionService(repository, agent);
  const app = new OpenAPIHono();
  registerDecisionRoutes(app, service, {
    token: 'test-token',
    resolve: (id, connectionId) => agent.resolve(id, connectionId),
  });
  return {
    repository,
    agent,
    service,
    app,
    thread,
    rpc,
    starts: () => starts,
    lost: (missing = false) => {
      loseResponse = true;
      omitReceipt = missing;
    },
  };
}

describe('Codex request boundary', () => {
  it('rejects omitted, contradictory and multiple recommendations while allowing an explicit evidence gap', async () => {
    const f = fixture();

    const send = (body: unknown) =>
      f.app.request('/api/v1/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': 'Bearer test-token' },
        body: JSON.stringify(body),
      });

    const neutral = {
      ...question,
      options: question.options.map((option) => ({ ...option, recommended: false })),
      recommendation: '',
    };
    for (const invalid of [
      neutral,
      { ...question, recommendation: ' ' },
      {
        ...question,
        options: [...question.options, { ...question.options[0], id: 'other' }],
      },
      { ...question, recommendationUnavailableReason: 'Unknown preferences' },
    ]) {
      expect((await send(invalid)).status).toBeGreaterThanOrEqual(400);
    }
    expect(f.service.list()).toHaveLength(0);
    expect(
      (
        await send({
          ...neutral,
          recommendationUnavailableReason:
            'The user has not supplied their preferred report length.',
        })
      ).status,
    ).toBe(200);
    expect(f.service.list()[0]?.options.some((option) => option.recommended)).toBe(false);
  });
  it('authenticates, rejects forged state, binds context and deduplicates concurrent create/restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-codex-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const f = fixture(join(root, 'decisions.sqlite'));

    const send = (body: unknown, token = 'test-token') =>
      f.app.request('/api/v1/decisions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'authorization': `Bearer ${token}` },
        body: JSON.stringify(body),
      });

    expect((await send(question, 'wrong')).status).toBe(401);
    expect((await send({ ...question, status: 'applied' })).status).toBeGreaterThanOrEqual(400);
    const responses = await Promise.all([send(question), send(question)]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const first = decisionSchema.parse(await responses[0].json());
    expect(first).toMatchObject({
      status: 'awaiting_answer',
      context: { threadId, taskRevision: 'origin-turn' },
    });
    expect(f.service.list()).toHaveLength(1);
    const reopened = fixture(join(root, 'decisions.sqlite'));
    expect(
      (
        await reopened.service.create(question, () => {
          throw new Error('Should use durable registration');
        })
      ).id,
    ).toBe(first.id);
    expect((await send({ ...question, question: 'Changed?' })).status).toBe(409);
    expect(
      (await send({ ...question, threadId: '11111111-1111-4111-8111-111111111111' })).status,
    ).toBe(409);
  });

  it('delivers the whole answer to the original thread and reconciles a lost response after reopening storage', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-receipt-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'decisions.sqlite');
    const f = fixture(path);
    const item = await f.service.create(question, (id) => f.agent.resolve(id));
    f.service.answer(item.id, {
      id: 'answer',
      expectedRevision: 0,
      intent: 'decide',
      optionId: 'short',
      text: 'Keep the date too.',
    });
    f.lost();
    await f.service.dispatch(item.id);
    expect(f.service.get(item.id).status).toBe('delivery_failed');
    const second = new SqliteDecisionRepository(path);
    cleanup.push(() => second.close());
    const recovered = new DecisionService(second, gateway(f.rpc, second));
    recovered.retry(item.id, recovered.get(item.id).revision);
    await recovered.dispatch(item.id);
    expect(recovered.get(item.id).status).toBe('delivered');
    expect(f.starts()).toBe(1);
    const input = JSON.stringify(f.thread.turns.at(-1)?.items);
    expect(input).toContain('Keep the date too.');
    expect(input).toContain('No file writes');
    expect(input).toContain('One line');
  });

  it('keeps ambiguous sends unresolved across gateway restarts instead of blindly replaying', async () => {
    const root = mkdtempSync(join(tmpdir(), 'lf-uncertain-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const path = join(root, 'decisions.sqlite');
    const f = fixture(path);
    const item = await f.service.create(question, (id) => f.agent.resolve(id));
    const saved = f.service.answer(item.id, {
      id: 'answer',
      expectedRevision: 0,
      intent: 'decide',
      text: 'One line',
    });
    f.lost(true);
    await f.service.dispatch(item.id);
    const reopened = new SqliteDecisionRepository(path);
    cleanup.push(() => reopened.close());
    const service = new DecisionService(reopened, gateway(f.rpc, reopened));
    service.retry(item.id, service.get(item.id).revision);
    await service.dispatch(item.id);
    expect(f.starts()).toBe(1);
    expect(service.get(item.id).status).toBe('delivery_failed');
    expect(service.get(item.id).answers).toEqual(saved.answers);
  });

  it('does not send to a busy, changed or unregistered conversation', async () => {
    const f = fixture();
    const item = await f.service.create(question, (id) => f.agent.resolve(id));
    f.service.answer(item.id, {
      id: 'answer',
      expectedRevision: 0,
      intent: 'research',
      text: 'Investigate first',
    });
    f.thread.turns[0]!.status = 'inProgress';
    await f.service.dispatch(item.id);
    expect(f.service.get(item.id).status).toBe('delivery_failed');
    f.thread.turns[0]!.status = 'completed';
    f.thread.turns.push({ id: 'unrelated-turn', status: 'completed', items: [] });
    f.service.retry(item.id, f.service.get(item.id).revision);
    await f.service.dispatch(item.id);
    expect(f.service.get(item.id).status).toBe('superseded');
    expect(f.starts()).toBe(0);
    await expect(f.agent.resolve('unregistered')).rejects.toThrow('session_not_allowed');
  });

  it('serializes concurrent dispatch reservations across service instances', async () => {
    const f = fixture();
    const item = await f.service.create(question, (id) => f.agent.resolve(id));
    const saved = f.service.answer(item.id, {
      id: 'answer',
      expectedRevision: 0,
      intent: 'research',
      text: 'Investigate first',
    });
    const delivery: AnswerDelivery = {
      id: `${item.id}:answer`,
      decisionId: item.id,
      context: item.context,
      question: item.question,
      mode: item.mode,
      constraints: item.constraints,
      assumption: item.assumption,
      answer: saved.answers[0]!,
      selectedOption: undefined,
    };
    const second = gateway(f.rpc, f.repository);
    await Promise.allSettled([f.agent.deliver(delivery), second.deliver(delivery)]);
    expect(f.starts()).toBe(1);
    expect(answerMessage(delivery)).toContain('"intent":"research"');
  });

  it('runs the bundled skill script against HTTP and retries the same registration without exposing credentials', async () => {
    const f = fixture();
    const root = mkdtempSync(join(tmpdir(), 'lf-script-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const listener = getRequestListener(f.app.fetch);
    const server = createServer((request, response) => {
      void listener(request, response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    cleanup.push(() => server.close());
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const config = join(root, 'config.json');
    const input = join(root, 'input.json');
    writeFileSync(
      config,
      JSON.stringify({ url, uiUrl: `${url}/ko/decisions`, token: 'test-token' }),
      { mode: 0o600 },
    );
    const { key: _key, threadId: _thread, ...body } = question;
    writeFileSync(input, JSON.stringify(body));

    const run = () =>
      execa(
        'python3',
        [
          '../../.agents/skills/leverframe-ask/scripts/ask.py',
          '--config',
          config,
          '--file',
          input,
          '--key',
          'script-test',
        ],
        {
          env: { CODEX_THREAD_ID: threadId },
          reject: false,
        },
      );

    const first = await run();
    expect(first.exitCode).toBe(0);
    expect(first.stdout).not.toContain('test-token');
    const second = await run();
    expect(second.stdout).toBe(first.stdout);
    expect(f.service.list()).toHaveLength(1);
    writeFileSync(input, JSON.stringify({ ...body, project: '' }));
    const missingProject = await run();
    expect(missingProject.stderr).toContain('invalid_question');
    expect(missingProject.stderr).toContain('project must contain');
    expect(missingProject.stderr).not.toContain('httpStatus');
    expect(f.service.list()).toHaveLength(1);
    writeFileSync(
      input,
      JSON.stringify({
        ...body,
        options: body.options.map((option) => ({ ...option, recommended: false })),
        recommendation: '',
      }),
    );
    const missingRecommendation = await run();
    expect(missingRecommendation.exitCode).toBe(1);
    expect(missingRecommendation.stderr).toContain('recommendation_required');
    expect(missingRecommendation.stderr).toContain('exactly one');
    expect(f.service.list()).toHaveLength(1);
    writeFileSync(input, JSON.stringify({ ...body, recommendationUnavailableReason: null }));
    expect((await run()).stderr).toContain('omit recommendationUnavailableReason');
    writeFileSync(input, JSON.stringify({ ...body, question: 'Changed' }));
    const conflict = await run();
    expect(conflict.exitCode).toBe(1);
    expect(conflict.stderr).toContain('409');
    writeFileSync(
      config,
      JSON.stringify({
        url,
        uiUrl: `${url}/ko/decisions`,
        token: 'test-token',
        connectionId: 'local-codex',
      }),
    );
    writeFileSync(input, JSON.stringify(body));
    const namespaced = await run();
    expect(namespaced.exitCode).toBe(0);
    expect(namespaced.stdout).not.toBe(first.stdout);
    expect(f.service.list()).toHaveLength(2);
    writeFileSync(
      input,
      JSON.stringify({ ...body, source: { connectionId: 'forged', sessionId: 'other' } }),
    );
    expect((await run()).stderr).toContain('invalid_input_or_configuration');
    writeFileSync(input, 'not json');
    expect((await run()).stderr).toContain('invalid_input_or_configuration');
  });
});

it('observes loaded pagination and refuses unknown native turn states', async () => {
  let status = 'completed';
  let loaded = true;
  let canAcceptDirectInput: boolean | null = true;
  const calls: string[] = [];
  const observer = new CodexSessionObserver(
    {
      call: (method, params) => {
        calls.push(method);
        if (method === 'thread/read') {
          return Promise.resolve({
            thread: {
              id: threadId,
              cwd: '/test',
              canAcceptDirectInput,
              turns: [{ id: 'turn', status, items: [] }],
            },
          });
        }
        if (!loaded) {
          return Promise.resolve({ data: [], nextCursor: null });
        }
        return Promise.resolve(
          params.cursor
            ? { data: [threadId], nextCursor: null }
            : { data: ['other-session'], nextCursor: 'page-2' },
        );
      },
    },
    new Map([[threadId, '/test']]),
  );
  expect((await observer.read(threadId)).state).toBe('ready');
  expect(calls.filter((method) => method === 'thread/loaded/list')).toHaveLength(2);
  status = 'future-unknown-state';
  expect((await observer.read(threadId)).state).toBe('offline');
  status = 'completed';
  loaded = false;
  canAcceptDirectInput = null;
  expect(await observer.read(threadId)).toEqual({
    revision: 'turn',
    state: 'offline',
    messages: [],
  });
  expect(await observer.isLoaded(threadId)).toBe(false);
});
