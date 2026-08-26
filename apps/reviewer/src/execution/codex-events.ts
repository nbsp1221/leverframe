import { reviewResultSchema } from '../review/result.js';
import type { ExecutionTraceStore, TraceEventInput } from './trace.js';

const HEARTBEAT_MILLISECONDS = 15_000;
const MAX_RAW_EVENT_BYTES = 1024 * 1024;

export class CodexExecutionRecorder {
  readonly #commandStarts = new Map<string, { command: string; startedAt: number }>();
  #buffer = '';
  #droppingOversizedLine = false;
  #heartbeat: NodeJS.Timeout | undefined;
  #malformedNoticeWritten = false;
  #unknownNoticeWritten = false;
  #oversizedNoticeWritten = false;

  constructor(
    readonly traceStore: ExecutionTraceStore,
    readonly jobId: number,
    readonly attempt: number,
  ) {
    this.#append({ type: 'attempt_started' });
    this.pulse();
  }

  start(): void {
    if (this.#heartbeat !== undefined) {
      return;
    }
    this.#heartbeat = setInterval(() => this.pulse(), HEARTBEAT_MILLISECONDS);
    this.#heartbeat.unref();
  }

  stop(): void {
    if (this.#heartbeat !== undefined) {
      clearInterval(this.#heartbeat);
      this.#heartbeat = undefined;
    }
    if (this.#buffer.trim() !== '') {
      this.#recordLine(this.#buffer);
    }
    this.#buffer = '';
    this.#completeOrphanCommands('interrupted');
  }

  pulse(): void {
    this.#append({ type: 'process_heartbeat' });
  }

  write(chunk: string | Uint8Array): void {
    let text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    if (this.#droppingOversizedLine) {
      const newline = text.indexOf('\n');
      if (newline < 0) {
        return;
      }
      this.#droppingOversizedLine = false;
      text = text.slice(newline + 1);
    }
    this.#buffer += text;
    while (true) {
      const newline = this.#buffer.indexOf('\n');
      if (newline < 0) {
        break;
      }
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '');
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.trim() !== '') {
        if (Buffer.byteLength(line) > MAX_RAW_EVENT_BYTES) {
          this.#recordOversizedNotice();
        } else {
          this.#recordLine(line);
        }
      }
    }
    if (Buffer.byteLength(this.#buffer) > MAX_RAW_EVENT_BYTES) {
      this.#buffer = '';
      this.#droppingOversizedLine = true;
      this.#recordOversizedNotice();
    }
  }

  #recordLine(line: string): void {
    let event: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(line);
      if (!isRecord(value)) {
        throw new Error('event is not an object');
      }
      event = value;
    } catch {
      if (!this.#malformedNoticeWritten) {
        this.#malformedNoticeWritten = true;
        this.#append({
          type: 'trace_notice',
          noticeCode: 'MALFORMED_CODEX_EVENT',
          message: 'A malformed Codex event was ignored.',
        });
      }
      return;
    }

    const type = stringValue(event.type);
    if (type === 'thread.started') {
      this.#append({ type: 'thread_started' });
      return;
    }
    if (type === 'turn.started') {
      this.#append({ type: 'turn_started' });
      return;
    }
    if (type === 'turn.completed') {
      this.#completeOrphanCommands('unknown');
      this.#append({ type: 'turn_completed' });
      return;
    }
    if (type === 'turn.failed' || type === 'error') {
      this.#completeOrphanCommands('failed');
      this.#append({
        type: 'turn_failed',
        message: errorMessage(event.error) ?? errorMessage(event.message) ?? 'Codex turn failed.',
      });
      return;
    }
    if ((type === 'item.started' || type === 'item.completed') && isRecord(event.item)) {
      if (this.#recordItem(type, event.item)) {
        return;
      }
    }
    if (!this.#unknownNoticeWritten) {
      this.#unknownNoticeWritten = true;
      this.#append({
        type: 'trace_notice',
        noticeCode: 'UNKNOWN_CODEX_EVENT',
        message: 'An unsupported Codex event was ignored.',
      });
    }
  }

  #recordItem(
    eventType: 'item.started' | 'item.completed',
    item: Record<string, unknown>,
  ): boolean {
    const itemType = stringValue(item.type);
    const itemId = stringValue(item.id);
    if (itemType === 'command_execution' && itemId !== undefined) {
      if (eventType === 'item.started') {
        const command = stringValue(item.command) ?? 'command unavailable';
        this.#commandStarts.set(itemId, { command, startedAt: Date.now() });
        this.#append({
          type: 'command_started',
          itemId,
          command,
          status: stringValue(item.status) ?? 'running',
        });
      } else {
        const started = this.#commandStarts.get(itemId);
        const command = stringValue(item.command);
        const exitCode = numberValue(item.exit_code);
        const output = stringValue(item.aggregated_output) ?? stringValue(item.output);
        this.#commandStarts.delete(itemId);
        this.#append({
          type: 'command_completed',
          itemId,
          ...(command === undefined ? {} : { command }),
          status: stringValue(item.status) ?? 'completed',
          ...(exitCode === undefined ? {} : { exitCode }),
          ...(started === undefined
            ? {}
            : { durationMilliseconds: Date.now() - started.startedAt }),
          ...(output === undefined ? {} : { output }),
        });
      }
      return true;
    }
    if (itemType === 'agent_message' && eventType === 'item.completed') {
      const text = stringValue(item.text);
      if (text !== undefined && !isFinalReviewResult(text)) {
        this.#append({
          type: 'agent_message',
          ...(itemId === undefined ? {} : { itemId }),
          message: text,
        });
      }
      return true;
    }
    if (itemType === 'file_change') {
      this.#append({
        type: 'file_change',
        ...(itemId === undefined ? {} : { itemId }),
        status: stringValue(item.status) ?? eventType.replace('item.', ''),
        message: changedPaths(item),
      });
      return true;
    }
    if (itemType === 'mcp_tool_call' || itemType === 'web_search' || itemType === 'tool_call') {
      this.#append({
        type: 'tool_activity',
        ...(itemId === undefined ? {} : { itemId }),
        status: stringValue(item.status) ?? eventType.replace('item.', ''),
        message: stringValue(item.tool) ?? stringValue(item.name) ?? itemType,
      });
      return true;
    }
    if (itemType === 'reasoning') {
      return true;
    }
    return false;
  }

  #append(input: TraceEventInput): void {
    this.traceStore.append(this.jobId, this.attempt, input);
  }

  #completeOrphanCommands(status: string): void {
    for (const [itemId, started] of this.#commandStarts) {
      this.#append({
        type: 'command_completed',
        itemId,
        command: started.command,
        status,
        durationMilliseconds: Date.now() - started.startedAt,
      });
    }
    this.#commandStarts.clear();
  }

  #recordOversizedNotice(): void {
    this.#completeOrphanCommands('event_omitted');
    if (this.#oversizedNoticeWritten) {
      return;
    }
    this.#oversizedNoticeWritten = true;
    this.#append({
      type: 'trace_notice',
      noticeCode: 'OVERSIZED_CODEX_EVENT',
      message: 'An oversized Codex event was omitted.',
    });
  }
}

function isFinalReviewResult(value: string): boolean {
  try {
    return reviewResultSchema.safeParse(JSON.parse(value)).success;
  } catch {
    return false;
  }
}

function changedPaths(item: Record<string, unknown>): string {
  if (!Array.isArray(item.changes)) {
    return 'Codex reported a file change.';
  }
  const paths = item.changes
    .flatMap((change) => (isRecord(change) && typeof change.path === 'string' ? [change.path] : []))
    .slice(0, 20);
  return paths.length === 0 ? 'Codex reported a file change.' : paths.join(', ');
}

function errorMessage(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (isRecord(value)) {
    return stringValue(value.message);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) ? value : undefined;
}

export const codexHeartbeatMilliseconds = HEARTBEAT_MILLISECONDS;
