import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { type ReviewExecutionEvent, reviewExecutionEventSchema } from '@repo/contracts';
import { redactFailureExcerpt, redactSensitiveText } from '../storage/failure.js';

const TRACE_FILE = 'execution-trace.jsonl';
const TRACE_SCHEMA_VERSION = 1 as const;
const MAX_TRACE_BYTES = 4 * 1024 * 1024;
const MAX_TRACE_EVENTS = 512;
const LIMIT_NOTICE_RESERVED_BYTES = 512;
const MAX_COMMAND_BYTES = 2 * 1024;
const MAX_MESSAGE_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024;

export interface TraceEventInput {
  type: ReviewExecutionEvent['type'];
  itemId?: string;
  command?: string;
  status?: string;
  exitCode?: number;
  durationMilliseconds?: number;
  output?: string;
  message?: string;
  noticeCode?: string;
}

interface TraceState {
  bytes: number;
  count: number;
  sequence: number;
  truncated: boolean;
}

export interface TraceSnapshotData {
  available: boolean;
  unavailableReason: string | null;
  startedAt: string | null;
  processHeartbeatAt: string | null;
  lastActivityAt: string | null;
  lastSequence: number;
  traceTruncated: boolean;
  currentCommand: { item_id: string; command: string; started_at: string } | null;
  events: ReviewExecutionEvent[];
}

export class ExecutionTraceStore {
  readonly #states = new Map<number, TraceState>();
  readonly #privatePaths: string[];

  constructor(
    readonly jobsDirectory: string,
    readonly environment: NodeJS.ProcessEnv = process.env,
  ) {
    this.#privatePaths = [jobsDirectory, environment.APP_DATA_DIRECTORY, environment.HOME]
      .filter((value): value is string => typeof value === 'string' && value.length > 1)
      .sort((left, right) => right.length - left.length);
  }

  append(jobId: number, attempt: number, input: TraceEventInput): ReviewExecutionEvent | undefined {
    try {
      const state = this.#state(jobId);
      if (state.truncated) {
        return undefined;
      }
      const event = this.#event(state.sequence + 1, attempt, input);
      const line = `${JSON.stringify(event)}\n`;
      const lineBytes = Buffer.byteLength(line);
      if (
        state.count >= MAX_TRACE_EVENTS - 1 ||
        state.bytes + lineBytes > MAX_TRACE_BYTES - LIMIT_NOTICE_RESERVED_BYTES
      ) {
        this.#appendLimitNotice(jobId, attempt, state);
        return undefined;
      }
      this.#write(jobId, line);
      state.bytes += lineBytes;
      state.count += 1;
      state.sequence = event.sequence;
      return event;
    } catch (error) {
      console.warn(`execution trace append failed for job ${jobId}: ${safeError(error)}`);
      return undefined;
    }
  }

  read(jobId: number, currentAttempt: number): TraceSnapshotData {
    const path = this.path(jobId);
    if (!existsSync(path)) {
      return unavailableSnapshot();
    }
    let events: ReviewExecutionEvent[];
    try {
      events = parseEvents(readFileSync(path, 'utf8'));
    } catch (error) {
      console.warn(`execution trace read failed for job ${jobId}: ${safeError(error)}`);
      return unavailableSnapshot('TRACE_UNAVAILABLE');
    }
    if (events.length === 0) {
      return unavailableSnapshot('TRACE_UNAVAILABLE');
    }
    const currentEvents = events.filter((event) => event.attempt === currentAttempt);
    const commands = new Map<string, { item_id: string; command: string; started_at: string }>();
    let startedAt: string | null = null;
    let processHeartbeatAt: string | null = null;
    let lastActivityAt: string | null = null;
    for (const event of currentEvents) {
      if (event.type === 'attempt_started') {
        startedAt = event.observed_at;
      } else if (event.type === 'process_heartbeat') {
        processHeartbeatAt = event.observed_at;
      } else {
        lastActivityAt = event.observed_at;
      }
      if (event.type === 'command_started' && event.item_id && event.command) {
        commands.set(event.item_id, {
          item_id: event.item_id,
          command: event.command,
          started_at: event.observed_at,
        });
      } else if (event.type === 'command_completed' && event.item_id) {
        commands.delete(event.item_id);
      }
    }
    return {
      available: true,
      unavailableReason: null,
      startedAt,
      processHeartbeatAt,
      lastActivityAt,
      lastSequence: events.at(-1)?.sequence ?? 0,
      traceTruncated: events.some(
        (event) => event.type === 'trace_notice' && event.notice_code === 'TRACE_LIMIT_REACHED',
      ),
      currentCommand: [...commands.values()].at(-1) ?? null,
      events,
    };
  }

  path(jobId: number): string {
    return join(this.jobsDirectory, String(jobId), TRACE_FILE);
  }

  #appendLimitNotice(jobId: number, attempt: number, state: TraceState): void {
    const notice = this.#event(state.sequence + 1, attempt, {
      type: 'trace_notice',
      noticeCode: 'TRACE_LIMIT_REACHED',
      message:
        'Additional execution trace events were omitted because the trace limit was reached.',
    });
    const line = `${JSON.stringify(notice)}\n`;
    const bytes = Buffer.byteLength(line);
    if (state.bytes + bytes <= MAX_TRACE_BYTES && state.count < MAX_TRACE_EVENTS) {
      this.#write(jobId, line);
      state.bytes += bytes;
      state.count += 1;
      state.sequence = notice.sequence;
    }
    state.truncated = true;
  }

  #event(sequence: number, attempt: number, input: TraceEventInput): ReviewExecutionEvent {
    const command = boundedText(
      input.command,
      MAX_COMMAND_BYTES,
      this.environment,
      this.#privatePaths,
    );
    const message = boundedText(
      input.message,
      MAX_MESSAGE_BYTES,
      this.environment,
      this.#privatePaths,
    );
    const output = boundedText(
      input.output,
      MAX_OUTPUT_BYTES,
      this.environment,
      this.#privatePaths,
      true,
    );
    return reviewExecutionEventSchema.parse({
      schema_version: TRACE_SCHEMA_VERSION,
      sequence,
      attempt,
      observed_at: new Date().toISOString(),
      type: input.type,
      item_id: input.itemId ?? null,
      command: command.value,
      status: input.status ?? null,
      exit_code: input.exitCode ?? null,
      duration_ms: input.durationMilliseconds ?? null,
      output: output.value,
      output_truncated: output.truncated,
      message: message.value,
      notice_code: input.noticeCode ?? null,
    });
  }

  #state(jobId: number): TraceState {
    const known = this.#states.get(jobId);
    if (known !== undefined) {
      return known;
    }
    const path = this.path(jobId);
    const events = existsSync(path) ? parseEvents(readFileSync(path, 'utf8')) : [];
    const state = {
      bytes: existsSync(path) ? statSync(path).size : 0,
      count: events.length,
      sequence: events.at(-1)?.sequence ?? 0,
      truncated: events.some(
        (event) => event.type === 'trace_notice' && event.notice_code === 'TRACE_LIMIT_REACHED',
      ),
    };
    this.#states.set(jobId, state);
    return state;
  }

  #write(jobId: number, line: string): void {
    const directory = join(this.jobsDirectory, String(jobId));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    appendFileSync(this.path(jobId), line, { encoding: 'utf8', mode: 0o600 });
  }
}

function parseEvents(value: string): ReviewExecutionEvent[] {
  const events: ReviewExecutionEvent[] = [];
  for (const line of value.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed = reviewExecutionEventSchema.safeParse(JSON.parse(line));
      if (parsed.success) {
        events.push(parsed.data);
      }
    } catch {
      // A diagnostic file must not make the review API unavailable.
    }
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

function boundedText(
  value: string | undefined,
  maxBytes: number,
  environment: NodeJS.ProcessEnv,
  privatePaths: readonly string[],
  tail = false,
): { value: string | null; truncated: boolean } {
  if (value === undefined) {
    return { value: null, truncated: false };
  }
  const sanitized = stripPrivatePaths(
    stripUnsafeCharacters(redactSensitiveText(value, environment)),
    privatePaths,
  );
  const bytes = Buffer.from(sanitized, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return { value: sanitized, truncated: false };
  }
  const slice = tail ? bytes.subarray(bytes.byteLength - maxBytes) : bytes.subarray(0, maxBytes);
  let result = slice.toString('utf8');
  result = tail ? result.replace(/^\uFFFD+/, '') : result.replace(/\uFFFD+$/, '');
  while (Buffer.byteLength(result, 'utf8') > maxBytes) {
    result = tail ? result.slice(1) : result.slice(0, -1);
  }
  return { value: result, truncated: true };
}

function stripPrivatePaths(value: string, privatePaths: readonly string[]): string {
  let result = value;
  for (const privatePath of privatePaths) {
    result = result.replaceAll(privatePath, '[PRIVATE_PATH]');
  }
  return result;
}

function stripUnsafeCharacters(value: string): string {
  const withoutAnsi = value.replace(
    new RegExp(
      `${String.fromCodePoint(27)}(?:[@-_][0-?]*[ -/]*[@-~]|\\][^${String.fromCodePoint(7)}]*(?:${String.fromCodePoint(7)}|${String.fromCodePoint(27)}\\\\))`,
      'g',
    ),
    '',
  );
  let safe = '';
  for (const character of withoutAnsi) {
    const code = character.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) {
      safe += character;
    }
  }
  return safe;
}

function unavailableSnapshot(reason = 'TRACE_NOT_CAPTURED'): TraceSnapshotData {
  return {
    available: false,
    unavailableReason: reason,
    startedAt: null,
    processHeartbeatAt: null,
    lastActivityAt: null,
    lastSequence: 0,
    traceTruncated: false,
    currentCommand: null,
    events: [],
  };
}

function safeError(error: unknown): string {
  return (
    redactFailureExcerpt(error instanceof Error ? error.message : String(error)).split('\n')[0] ??
    'unknown error'
  );
}

export const executionTraceLimits = {
  commandBytes: MAX_COMMAND_BYTES,
  eventCount: MAX_TRACE_EVENTS,
  fileBytes: MAX_TRACE_BYTES,
  messageBytes: MAX_MESSAGE_BYTES,
  outputBytes: MAX_OUTPUT_BYTES,
} as const;
