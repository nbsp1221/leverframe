import type { DatabaseSync } from 'node:sqlite';
import type {
  DevelopmentAttempt,
  DevelopmentEventInput,
  DevelopmentPhase,
  DevelopmentRun,
} from './development-repository.js';
import { transaction } from './connection.js';

export interface DevelopmentClarificationQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  options?: Array<{ label: string; description: string }>;
}

export interface RequestClarificationInput {
  runId: number;
  attemptId: number;
  workRevisionId: number;
  generation: number;
  expectedLockVersion: number;
  phase: Extract<DevelopmentPhase, 'PLANNING' | 'IMPLEMENTING' | 'VERIFYING' | 'REVIEWING'>;
  requestId: string;
  threadId: string;
  turnId: string;
  questions: DevelopmentClarificationQuestion[];
  prompt: string;
  now?: string;
}

export interface ResolveClarificationInput {
  runId: number;
  interruptId: number;
  expectedLockVersion: number;
  answers: Record<string, string[]>;
  now?: string;
}

type TransitionInput = {
  id: number;
  expectedGeneration: number;
  expectedLockVersion: number;
  phase: DevelopmentPhase;
  priorPhase?: DevelopmentPhase;
  event: DevelopmentEventInput;
};

type RequestDependencies = {
  conflict: (message: string) => Error;
  requireAttempt: (id: number) => DevelopmentAttempt;
  requireRun: (id: number) => DevelopmentRun;
  transition: (input: TransitionInput) => DevelopmentRun;
};

type ResolveDependencies = Omit<RequestDependencies, 'requireAttempt'>;

export function requestClarification(
  database: DatabaseSync,
  input: RequestClarificationInput,
  dependencies: RequestDependencies,
): number {
  const now = input.now ?? new Date().toISOString();
  return transaction(database, () => {
    const run = dependencies.requireRun(input.runId);
    const attempt = dependencies.requireAttempt(input.attemptId);
    if (
      run.phase !== input.phase ||
      run.generation !== input.generation ||
      run.lockVersion !== input.expectedLockVersion ||
      run.workRevisionId !== input.workRevisionId ||
      attempt.runId !== run.id ||
      attempt.generation !== run.generation ||
      attempt.threadId !== input.threadId ||
      attempt.turnId !== input.turnId ||
      !['CLAIMED', 'RUNNING'].includes(attempt.state)
    ) {
      throw dependencies.conflict(`clarification request for run ${input.runId} is stale`);
    }
    const result = database
      .prepare(`
        INSERT INTO development_interrupts (
          run_id, work_revision_id, attempt_id, generation, kind, status, request_id,
          thread_id, turn_id, prompt, context_json, requested_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'CLARIFICATION', 'OPEN', ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        run.id,
        run.workRevisionId,
        attempt.id,
        run.generation,
        input.requestId,
        input.threadId,
        input.turnId,
        input.prompt,
        JSON.stringify({ questions: input.questions }),
        now,
        now,
        now,
      );
    const waiting = database
      .prepare(`
        UPDATE development_attempts SET state = 'WAITING', updated_at = ?
        WHERE id = ? AND state IN ('CLAIMED','RUNNING')
      `)
      .run(now, attempt.id);
    if (waiting.changes !== 1) {
      throw dependencies.conflict(`development attempt ${attempt.id} changed`);
    }
    dependencies.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'WAITING_FOR_INPUT',
      priorPhase: input.phase,
      event: {
        type: 'clarification_required',
        source: 'CODEX',
        trust: 'HARNESS_OBSERVED',
        attemptId: attempt.id,
        payload: { question_count: input.questions.length },
        observedAt: now,
      },
    });
    return Number(result.lastInsertRowid);
  });
}

export function resolveClarification(
  database: DatabaseSync,
  input: ResolveClarificationInput,
  dependencies: ResolveDependencies,
): DevelopmentRun {
  const now = input.now ?? new Date().toISOString();
  return transaction(database, () => {
    const run = dependencies.requireRun(input.runId);
    if (run.phase !== 'WAITING_FOR_INPUT' || run.priorPhase === undefined) {
      throw dependencies.conflict(`development run ${run.id} is not waiting for input`);
    }
    const interrupt = database
      .prepare(`
        SELECT attempt_id, context_json FROM development_interrupts
        WHERE id = ? AND run_id = ? AND kind = 'CLARIFICATION' AND status = 'OPEN'
          AND lock_version = ? AND generation = ?
      `)
      .get(input.interruptId, run.id, input.expectedLockVersion, run.generation) as
      | { attempt_id: number; context_json: string }
      | undefined;
    if (interrupt === undefined) {
      throw dependencies.conflict(`clarification ${input.interruptId} changed`);
    }
    const expectedIds = parseClarificationContext(interrupt.context_json)
      .questions.map((question) => question.id)
      .sort();
    const answerIds = Object.keys(input.answers).sort();
    if (
      expectedIds.length !== answerIds.length ||
      expectedIds.some((id, index) => id !== answerIds[index])
    ) {
      throw dependencies.conflict('clarification answers do not match the current questions');
    }
    const resolved = database
      .prepare(`
        UPDATE development_interrupts SET
          status = 'ANSWERED', response = ?, resolved_at = ?, updated_at = ?,
          lock_version = lock_version + 1
        WHERE id = ? AND status = 'OPEN' AND lock_version = ?
      `)
      .run(JSON.stringify(input.answers), now, now, input.interruptId, input.expectedLockVersion);
    if (resolved.changes !== 1) {
      throw dependencies.conflict(`clarification ${input.interruptId} changed`);
    }
    const running = database
      .prepare(`
        UPDATE development_attempts SET state = 'RUNNING', updated_at = ?
        WHERE id = ? AND state = 'WAITING'
      `)
      .run(now, interrupt.attempt_id);
    if (running.changes !== 1) {
      throw dependencies.conflict(`clarification attempt ${interrupt.attempt_id} changed`);
    }
    return dependencies.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: run.priorPhase,
      event: {
        type: 'clarification_answered',
        source: 'HUMAN',
        trust: 'HUMAN_DECIDED',
        attemptId: interrupt.attempt_id,
        payload: { question_count: answerIds.length },
        observedAt: now,
      },
    });
  });
}

export function parseClarificationContext(value: string): {
  questions: DevelopmentClarificationQuestion[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('stored clarification context is malformed');
  }
  const questions =
    parsed !== null && typeof parsed === 'object'
      ? (parsed as { questions?: unknown }).questions
      : undefined;
  if (!Array.isArray(questions) || questions.length === 0 || questions.length > 3) {
    throw new Error('stored clarification context is invalid');
  }
  if (questions.some((question) => !validQuestion(question))) {
    throw new Error('stored clarification questions are invalid');
  }
  return { questions: questions as DevelopmentClarificationQuestion[] };
}

function validQuestion(question: unknown): boolean {
  return (
    question !== null &&
    typeof question === 'object' &&
    typeof (question as { id?: unknown }).id === 'string' &&
    typeof (question as { header?: unknown }).header === 'string' &&
    typeof (question as { question?: unknown }).question === 'string' &&
    typeof (question as { isOther?: unknown }).isOther === 'boolean' &&
    ((question as { options?: unknown }).options === undefined ||
      Array.isArray((question as { options?: unknown }).options))
  );
}
