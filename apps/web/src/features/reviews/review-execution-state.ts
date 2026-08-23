import type { ReviewExecutionEvent, ReviewExecutionSnapshot } from '@repo/contracts';

export function applyExecutionEvent(
  snapshot: ReviewExecutionSnapshot,
  event: ReviewExecutionEvent,
): ReviewExecutionSnapshot {
  if (snapshot.events.some((existing) => existing.sequence === event.sequence)) {
    return snapshot;
  }
  let currentCommand = snapshot.current_command;
  if (event.type === 'command_started' && event.item_id && event.command) {
    currentCommand = {
      item_id: event.item_id,
      command: event.command,
      started_at: event.observed_at,
    };
  } else if (event.type === 'command_completed' && currentCommand?.item_id === event.item_id) {
    currentCommand = null;
  }
  return {
    ...snapshot,
    available: true,
    unavailable_reason: null,
    process_heartbeat_at:
      event.type === 'process_heartbeat' ? event.observed_at : snapshot.process_heartbeat_at,
    last_activity_at:
      event.type === 'process_heartbeat' || event.type === 'attempt_started'
        ? snapshot.last_activity_at
        : event.observed_at,
    last_sequence: Math.max(snapshot.last_sequence, event.sequence),
    trace_truncated:
      snapshot.trace_truncated ||
      (event.type === 'trace_notice' && event.notice_code === 'TRACE_LIMIT_REACHED'),
    current_command: currentCommand,
    events: [...snapshot.events, event].sort((left, right) => left.sequence - right.sequence),
  };
}

export function isTerminalExecution(status: ReviewExecutionSnapshot['status']): boolean {
  return ['completed', 'failed', 'superseded', 'cancelled'].includes(status);
}
