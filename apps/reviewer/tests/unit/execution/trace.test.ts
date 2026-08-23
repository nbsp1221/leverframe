import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CodexExecutionRecorder } from '../../../src/execution/codex-events.js';
import { ExecutionTraceStore, executionTraceLimits } from '../../../src/execution/trace.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function fixture(environment: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-trace-'));
  directories.push(root);
  return new ExecutionTraceStore(root, environment);
}

describe('execution trace', () => {
  it('frames split JSONL chunks and separates heartbeat from Codex activity', () => {
    const store = fixture();
    const recorder = new CodexExecutionRecorder(store, 42, 1);
    recorder.write('{"type":"thread.started"}\n{"type":"item.started","item":{"id":"cmd_1",');
    recorder.write('"type":"command_execution","command":"pnpm test","status":"in_progress"}}\n');
    recorder.pulse();
    recorder.write(
      '{"type":"item.completed","item":{"id":"cmd_1","type":"command_execution","command":"pnpm test","aggregated_output":"ok","exit_code":0,"status":"completed"}}',
    );
    recorder.stop();

    const snapshot = store.read(42, 1);
    expect(snapshot.available).toBe(true);
    expect(snapshot.processHeartbeatAt).not.toBeNull();
    expect(snapshot.lastActivityAt).toBe(snapshot.events.at(-1)?.observed_at);
    expect(snapshot.currentCommand).toBeNull();
    expect(snapshot.events.map((event) => event.type)).toEqual([
      'attempt_started',
      'process_heartbeat',
      'thread_started',
      'command_started',
      'process_heartbeat',
      'command_completed',
    ]);
  });

  it('suppresses reasoning and the final structured review while retaining progress messages', () => {
    const store = fixture();
    const recorder = new CodexExecutionRecorder(store, 7, 1);
    recorder.write(
      [
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'reason', type: 'reasoning', text: 'private reasoning' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: { id: 'message', type: 'agent_message', text: 'Checking tests.' },
        }),
        JSON.stringify({
          type: 'item.completed',
          item: {
            id: 'final',
            type: 'agent_message',
            text: JSON.stringify({
              findings: [],
              limitations: [],
              summary: 'done',
              tests_run: [],
            }),
          },
        }),
      ].join('\n'),
    );
    recorder.stop();
    const messages = store
      .read(7, 1)
      .events.filter((event) => event.type === 'agent_message')
      .map((event) => event.message);
    expect(messages).toEqual(['Checking tests.']);
  });

  it('redacts environment and sandbox credentials while retaining only the output tail', () => {
    const store = fixture({ REVIEW_TOKEN: 'super-secret-value' });
    store.append(9, 1, {
      type: 'command_completed',
      output: `${'x'.repeat(executionTraceLimits.outputBytes)} REVIEW_TOKEN=super-secret-value OPENAI_API_KEY=sk-proj-${'a'.repeat(40)}`,
    });
    const event = store.read(9, 1).events[0];
    expect(event?.output).not.toContain('super-secret-value');
    expect(event?.output).not.toContain('sk-proj-');
    expect(event?.output).toContain('[REDACTED]');
    expect(event?.output_truncated).toBe(true);
    expect(Buffer.byteLength(event?.output ?? '')).toBeLessThanOrEqual(
      executionTraceLimits.outputBytes,
    );
  });

  it('records one notice for malformed and unsupported Codex events', () => {
    const store = fixture();
    const recorder = new CodexExecutionRecorder(store, 11, 1);
    recorder.write('not-json\nnot-json\n{"type":"future.event"}\n{"type":"another.future"}\n');
    recorder.stop();
    expect(
      store
        .read(11, 1)
        .events.filter((event) => event.type === 'trace_notice')
        .map((event) => event.notice_code),
    ).toEqual(['MALFORMED_CODEX_EVENT', 'UNKNOWN_CODEX_EVENT']);
  });

  it('bounds oversized raw lines and closes commands whose completion event is unavailable', () => {
    const store = fixture();
    const recorder = new CodexExecutionRecorder(store, 12, 1);
    recorder.write(
      `${JSON.stringify({
        type: 'item.started',
        item: { id: 'cmd', type: 'command_execution', command: 'long-test' },
      })}\n`,
    );
    recorder.write('x'.repeat(1024 * 1024 + 1));
    recorder.write('\n');
    const liveSnapshot = store.read(12, 1);
    expect(liveSnapshot.currentCommand).toBeNull();
    expect(liveSnapshot.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ notice_code: 'OVERSIZED_CODEX_EVENT' }),
        expect.objectContaining({ type: 'command_completed', status: 'event_omitted' }),
      ]),
    );
    recorder.stop();
    expect(
      store
        .read(12, 1)
        .events.filter((event) => event.type === 'command_completed' && event.item_id === 'cmd'),
    ).toHaveLength(1);
  });

  it('persists the trace-limit notice when the byte limit is reached', () => {
    const store = fixture();
    for (let index = 0; index < executionTraceLimits.eventCount; index += 1) {
      store.append(16, 1, {
        type: 'command_completed',
        itemId: String(index),
        output: 'x'.repeat(executionTraceLimits.outputBytes),
      });
    }

    const snapshot = store.read(16, 1);
    expect(snapshot.traceTruncated).toBe(true);
    expect(snapshot.events.at(-1)).toMatchObject({
      type: 'trace_notice',
      notice_code: 'TRACE_LIMIT_REACHED',
    });
    expect(new ExecutionTraceStore(store.jobsDirectory, {}).read(16, 1).traceTruncated).toBe(true);
  });

  it('removes configured host paths before persistence', () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-private-path-'));
    directories.push(root);
    const store = new ExecutionTraceStore(join(root, 'jobs'), { HOME: root });
    store.append(13, 1, { type: 'agent_message', message: `reading ${root}/secret.txt` });
    expect(store.read(13, 1).events[0]?.message).toBe('reading [PRIVATE_PATH]/secret.txt');
  });

  it('continues sequence numbers across attempts and isolates current attempt state', () => {
    const store = fixture();
    store.append(14, 1, { type: 'attempt_started' });
    store.append(14, 1, {
      type: 'command_started',
      itemId: 'old-command',
      command: 'pnpm old',
    });
    const restartedStore = new ExecutionTraceStore(store.jobsDirectory, {});
    restartedStore.append(14, 2, { type: 'attempt_started' });
    restartedStore.append(14, 2, { type: 'process_heartbeat' });

    const snapshot = restartedStore.read(14, 2);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([1, 2, 3, 4]);
    expect(snapshot.startedAt).toBe(snapshot.events[2]?.observed_at);
    expect(snapshot.currentCommand).toBeNull();
  });

  it('removes terminal escapes and unsafe control characters', () => {
    const store = fixture();
    store.append(15, 1, {
      type: 'agent_message',
      message: `before${String.fromCodePoint(27)}[31mred${String.fromCodePoint(27)}[0m${String.fromCodePoint(0)}after`,
    });
    expect(store.read(15, 1).events[0]?.message).toBe('beforeredafter');
  });
});
