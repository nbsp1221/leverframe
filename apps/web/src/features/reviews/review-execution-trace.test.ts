import {
  type ReviewExecutionEvent,
  type ReviewExecutionSnapshot,
  reviewExecutionEventSchema,
  reviewExecutionSnapshotSchema,
} from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import { applyExecutionEvent } from './review-execution-state';

const snapshot: ReviewExecutionSnapshot = reviewExecutionSnapshotSchema.parse({
  review_id: 42,
  available: true,
  unavailable_reason: null,
  attempt: 1,
  status: 'running',
  stage: 'reviewing',
  started_at: '2026-08-24T00:00:00.000Z',
  process_heartbeat_at: null,
  last_activity_at: null,
  last_sequence: 0,
  trace_truncated: false,
  current_command: null,
  events: [],
});

function event(input: Partial<ReviewExecutionEvent>): ReviewExecutionEvent {
  return reviewExecutionEventSchema.parse({
    schema_version: 1,
    sequence: 1,
    attempt: 1,
    observed_at: '2026-08-24T00:00:01.000Z',
    type: 'process_heartbeat',
    item_id: null,
    command: null,
    status: null,
    exit_code: null,
    duration_ms: null,
    output: null,
    output_truncated: false,
    message: null,
    notice_code: null,
    ...input,
  });
}

describe('review execution state', () => {
  it('keeps process heartbeat separate from Codex activity', () => {
    const next = applyExecutionEvent(snapshot, event({}));
    expect(next.process_heartbeat_at).toBe('2026-08-24T00:00:01.000Z');
    expect(next.last_activity_at).toBeNull();
  });

  it('tracks the current command and ignores duplicate sequences', () => {
    const started = applyExecutionEvent(
      snapshot,
      event({
        type: 'command_started',
        item_id: 'cmd_1',
        command: 'pnpm test',
      }),
    );
    expect(started.current_command?.command).toBe('pnpm test');
    expect(applyExecutionEvent(started, started.events[0] ?? event({}))).toBe(started);

    const completed = applyExecutionEvent(
      started,
      event({
        sequence: 2,
        observed_at: '2026-08-24T00:00:03.000Z',
        type: 'command_completed',
        item_id: 'cmd_1',
        exit_code: 0,
      }),
    );
    expect(completed.current_command).toBeNull();
    expect(completed.last_activity_at).toBe('2026-08-24T00:00:03.000Z');
  });
});
