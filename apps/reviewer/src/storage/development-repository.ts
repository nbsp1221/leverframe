import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './connection.js';

export type DevelopmentPhase =
  | 'INTAKE'
  | 'PREPARING'
  | 'PLANNING'
  | 'AWAITING_PLAN_APPROVAL'
  | 'IMPLEMENTING'
  | 'VERIFYING'
  | 'AWAITING_PUBLICATION_APPROVAL'
  | 'PUBLISHING'
  | 'REVIEWING'
  | 'AWAITING_MERGE'
  | 'WAITING_FOR_INPUT'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export interface DevelopmentRun {
  id: number;
  repository: string;
  phase: DevelopmentPhase;
  priorPhase?: DevelopmentPhase;
  generation: number;
  lockVersion: number;
  workRevisionId: number;
  revision: number;
  goal: string;
  candidateHash?: string;
  lastActivityAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface DevelopmentEventInput {
  type: string;
  source: 'LEVERFRAME' | 'CODEX' | 'SANDBOX' | 'GITHUB' | 'TICKET' | 'HUMAN';
  trust: 'SYSTEM_OBSERVED' | 'HARNESS_OBSERVED' | 'AGENT_CLAIMED' | 'HUMAN_DECIDED';
  payload?: Record<string, unknown>;
  attemptId?: number;
  idempotencyKey?: string;
  observedAt?: string;
}

export interface DevelopmentAttempt {
  id: number;
  runId: number;
  workRevisionId: number;
  phase: DevelopmentPhase;
  attempt: number;
  generation: number;
  state: 'CLAIMED' | 'RUNNING' | 'WAITING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'LOST';
  leaseOwner?: string;
  leaseExpiresAt?: string;
}

export class DevelopmentConflictError extends Error {}

const phaseTransitions: Readonly<Record<DevelopmentPhase, readonly DevelopmentPhase[]>> = {
  INTAKE: ['PREPARING', 'FAILED', 'CANCELLED'],
  PREPARING: ['PLANNING', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'],
  PLANNING: ['AWAITING_PLAN_APPROVAL', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'],
  AWAITING_PLAN_APPROVAL: ['IMPLEMENTING', 'PLANNING', 'FAILED', 'CANCELLED'],
  IMPLEMENTING: ['VERIFYING', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'],
  VERIFYING: [
    'AWAITING_PUBLICATION_APPROVAL',
    'IMPLEMENTING',
    'WAITING_FOR_INPUT',
    'FAILED',
    'CANCELLED',
  ],
  AWAITING_PUBLICATION_APPROVAL: ['PUBLISHING', 'IMPLEMENTING', 'FAILED', 'CANCELLED'],
  PUBLISHING: ['REVIEWING', 'AWAITING_PUBLICATION_APPROVAL', 'FAILED', 'CANCELLED'],
  REVIEWING: ['AWAITING_MERGE', 'IMPLEMENTING', 'WAITING_FOR_INPUT', 'FAILED', 'CANCELLED'],
  AWAITING_MERGE: ['COMPLETED', 'IMPLEMENTING', 'FAILED', 'CANCELLED'],
  WAITING_FOR_INPUT: [],
  COMPLETED: [],
  FAILED: [],
  CANCELLED: [],
};

export class DevelopmentRepository {
  constructor(private readonly database: DatabaseSync) {}

  createRun(input: {
    repository: string;
    goal: string;
    externalSource?: { provider: string; id: string; key?: string; url?: string };
    now?: string;
  }): DevelopmentRun {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const result = this.database
        .prepare(`
          INSERT INTO development_runs (
            repository, phase, generation, lock_version, last_activity_at, created_at, updated_at
          ) VALUES (?, 'INTAKE', 1, 1, ?, ?, ?)
        `)
        .run(input.repository, now, now, now);
      const runId = Number(result.lastInsertRowid);
      const source = input.externalSource;
      const revision = this.database
        .prepare(`
          INSERT INTO development_work_revisions (
            run_id, revision, source_kind, goal, normalized_json,
            source_provider, source_external_id, source_external_key, source_url, created_at
          ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          runId,
          source === undefined ? 'WEB' : 'TICKET',
          input.goal,
          JSON.stringify({ goal: input.goal, repository: input.repository }),
          source?.provider ?? null,
          source?.id ?? null,
          source?.key ?? null,
          source?.url ?? null,
          now,
        );
      const revisionId = Number(revision.lastInsertRowid);
      this.database
        .prepare('UPDATE development_runs SET accepted_work_revision_id = ? WHERE id = ?')
        .run(revisionId, runId);
      if (source !== undefined) {
        this.database
          .prepare(`
            INSERT INTO development_external_refs (
              run_id, provider, kind, external_id, external_key, url, created_at, updated_at
            ) VALUES (?, ?, 'TICKET', ?, ?, ?, ?, ?)
          `)
          .run(runId, source.provider, source.id, source.key ?? null, source.url ?? null, now, now);
      }
      this.insertEvent(runId, 1, {
        type: 'run_created',
        source: 'HUMAN',
        trust: 'HUMAN_DECIDED',
        payload: { source: source === undefined ? 'web' : 'ticket' },
        observedAt: now,
      });
      return this.requireRun(runId);
    });
  }

  getRun(id: number): DevelopmentRun | undefined {
    const row = this.database
      .prepare(`
        SELECT r.*, w.revision, w.goal
        FROM development_runs r
        JOIN development_work_revisions w ON w.id = r.accepted_work_revision_id
        WHERE r.id = ?
      `)
      .get(id) as DevelopmentRunRow | undefined;
    return row === undefined ? undefined : mapRun(row);
  }

  requireRun(id: number): DevelopmentRun {
    const run = this.getRun(id);
    if (run === undefined) {
      throw new Error(`development run ${id} not found`);
    }
    return run;
  }

  transition(input: {
    id: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    phase: DevelopmentPhase;
    priorPhase?: DevelopmentPhase;
    advanceGeneration?: boolean;
    event: DevelopmentEventInput;
  }): DevelopmentRun {
    return transaction(this.database, () => {
      const current = this.requireRun(input.id);
      const isWaitingResume =
        current.phase === 'WAITING_FOR_INPUT' && current.priorPhase === input.phase;
      if (!isWaitingResume && !phaseTransitions[current.phase].includes(input.phase)) {
        throw new DevelopmentConflictError(
          `illegal development transition ${current.phase} -> ${input.phase}`,
        );
      }
      if (input.phase === 'WAITING_FOR_INPUT' && input.priorPhase !== current.phase) {
        throw new DevelopmentConflictError('waiting transition must preserve its prior phase');
      }
      if (input.phase !== 'WAITING_FOR_INPUT' && input.priorPhase !== undefined) {
        throw new DevelopmentConflictError('prior phase is only valid while waiting for input');
      }
      const now = input.event.observedAt ?? new Date().toISOString();
      const generation = input.expectedGeneration + (input.advanceGeneration === true ? 1 : 0);
      const result = this.database
        .prepare(`
          UPDATE development_runs SET
            phase = ?, prior_phase = ?, generation = ?, lock_version = lock_version + 1,
            last_activity_at = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND lock_version = ?
        `)
        .run(
          input.phase,
          input.priorPhase ?? null,
          generation,
          now,
          now,
          input.id,
          input.expectedGeneration,
          input.expectedLockVersion,
        );
      if (result.changes !== 1) {
        throw new DevelopmentConflictError(`development run ${input.id} changed`);
      }
      this.insertEvent(input.id, generation, { ...input.event, observedAt: now });
      return this.requireRun(input.id);
    });
  }

  setCandidate(input: {
    id: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    candidateHash: string;
    event: DevelopmentEventInput;
  }): DevelopmentRun {
    return transaction(this.database, () => {
      const now = input.event.observedAt ?? new Date().toISOString();
      const nextGeneration = input.expectedGeneration + 1;
      const result = this.database
        .prepare(`
          UPDATE development_runs SET
            candidate_hash = ?, generation = ?, lock_version = lock_version + 1,
            last_activity_at = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND lock_version = ?
        `)
        .run(
          input.candidateHash,
          nextGeneration,
          now,
          now,
          input.id,
          input.expectedGeneration,
          input.expectedLockVersion,
        );
      if (result.changes !== 1) {
        throw new DevelopmentConflictError(`development run ${input.id} changed`);
      }
      this.database
        .prepare(`
          UPDATE development_interrupts
          SET status = 'SUPERSEDED', resolved_at = ?, updated_at = ?, lock_version = lock_version + 1
          WHERE run_id = ? AND kind = 'PUBLICATION_APPROVAL' AND status = 'OPEN'
        `)
        .run(now, now, input.id);
      this.insertEvent(input.id, nextGeneration, { ...input.event, observedAt: now });
      return this.requireRun(input.id);
    });
  }

  claimAttempt(input: {
    runId: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    phase: Extract<
      DevelopmentPhase,
      'PREPARING' | 'PLANNING' | 'IMPLEMENTING' | 'VERIFYING' | 'PUBLISHING' | 'REVIEWING'
    >;
    executorKind: 'CODEX_APP_SERVER' | 'DETERMINISTIC' | 'REVIEWER';
    leaseOwner: string;
    leaseExpiresAt: string;
    codexProfile?: string;
    now?: string;
  }): DevelopmentAttempt {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const run = this.requireRun(input.runId);
      if (
        run.generation !== input.expectedGeneration ||
        run.lockVersion !== input.expectedLockVersion
      ) {
        throw new DevelopmentConflictError(`development run ${input.runId} changed`);
      }
      const attempt = Number(
        (
          this.database
            .prepare(
              'SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM development_attempts WHERE run_id = ? AND phase = ?',
            )
            .get(input.runId, input.phase) as { attempt: number }
        ).attempt,
      );
      let result;
      try {
        result = this.database
          .prepare(`
            INSERT INTO development_attempts (
              run_id, work_revision_id, phase, attempt, generation, executor_kind, codex_profile,
              state, lease_owner, lease_expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, ?)
          `)
          .run(
            input.runId,
            run.workRevisionId,
            input.phase,
            attempt,
            input.expectedGeneration,
            input.executorKind,
            input.codexProfile ?? null,
            input.leaseOwner,
            input.leaseExpiresAt,
            now,
            now,
          );
      } catch (error) {
        throw new DevelopmentConflictError(
          error instanceof Error ? error.message : `development run ${input.runId} already claimed`,
        );
      }
      const updated = this.database
        .prepare(`
          UPDATE development_runs
          SET lock_version = lock_version + 1, last_activity_at = ?, updated_at = ?
          WHERE id = ? AND generation = ? AND lock_version = ?
        `)
        .run(now, now, input.runId, input.expectedGeneration, input.expectedLockVersion);
      if (updated.changes !== 1) {
        throw new DevelopmentConflictError(`development run ${input.runId} changed`);
      }
      const id = Number(result.lastInsertRowid);
      this.insertEvent(input.runId, input.expectedGeneration, {
        type: 'attempt_claimed',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
        attemptId: id,
        payload: { executor_kind: input.executorKind, phase: input.phase },
        observedAt: now,
      });
      return this.requireAttempt(id);
    });
  }

  requireAttempt(id: number): DevelopmentAttempt {
    const row = this.database.prepare('SELECT * FROM development_attempts WHERE id = ?').get(id) as
      | DevelopmentAttemptRow
      | undefined;
    if (row === undefined) {
      throw new Error(`development attempt ${id} not found`);
    }
    return mapAttempt(row);
  }

  appendEvent(runId: number, generation: number, event: DevelopmentEventInput): number {
    return transaction(this.database, () => {
      const run = this.requireRun(runId);
      if (run.generation !== generation) {
        throw new DevelopmentConflictError(`development run ${runId} generation changed`);
      }
      return this.insertEvent(runId, generation, event);
    });
  }

  recordEvidence(input: {
    runId: number;
    workRevisionId: number;
    generation: number;
    candidateHash: string;
    criterion: string;
    method: 'COMMAND' | 'BROWSER' | 'INSPECTION' | 'EXTERNAL_OBSERVATION';
    observation: string;
    trust: DevelopmentEventInput['trust'];
    verdict: 'PASSED' | 'FAILED' | 'UNRESOLVED';
    attemptId?: number;
    commandOrArtifact?: string;
    resultCode?: string;
    excerpt?: string;
    now?: string;
  }): number {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const run = this.requireRun(input.runId);
      if (
        run.generation !== input.generation ||
        run.workRevisionId !== input.workRevisionId ||
        run.candidateHash !== input.candidateHash
      ) {
        throw new DevelopmentConflictError(`evidence candidate for run ${input.runId} is stale`);
      }
      const result = this.database
        .prepare(`
          INSERT INTO development_evidence (
            run_id, work_revision_id, attempt_id, generation, candidate_hash, criterion, method,
            observation, command_or_artifact, result_code, trust, excerpt, verdict, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId,
          input.workRevisionId,
          input.attemptId ?? null,
          input.generation,
          input.candidateHash,
          input.criterion,
          input.method,
          input.observation,
          input.commandOrArtifact ?? null,
          input.resultCode ?? null,
          input.trust,
          input.excerpt ?? null,
          input.verdict,
          now,
        );
      return Number(result.lastInsertRowid);
    });
  }

  openPublicationApproval(input: {
    runId: number;
    workRevisionId: number;
    generation: number;
    candidateHash: string;
    publicationKind: 'PUSH_AND_PR' | 'PUSH_EXISTING';
    prompt: string;
    context?: Record<string, unknown>;
    now?: string;
  }): number {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const run = this.requireRun(input.runId);
      if (
        run.generation !== input.generation ||
        run.workRevisionId !== input.workRevisionId ||
        run.candidateHash !== input.candidateHash
      ) {
        throw new DevelopmentConflictError(`publication candidate for run ${input.runId} is stale`);
      }
      const result = this.database
        .prepare(`
          INSERT INTO development_interrupts (
            run_id, work_revision_id, generation, kind, status, prompt, context_json,
            candidate_hash, publication_kind, requested_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'PUBLICATION_APPROVAL', 'OPEN', ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId,
          input.workRevisionId,
          input.generation,
          input.prompt,
          JSON.stringify(input.context ?? {}),
          input.candidateHash,
          input.publicationKind,
          now,
          now,
          now,
        );
      return Number(result.lastInsertRowid);
    });
  }

  resolvePublicationApproval(input: {
    interruptId: number;
    expectedLockVersion: number;
    candidateHash: string;
    approve: boolean;
    response?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE development_interrupts SET
          status = ?, response = ?, resolved_at = ?, updated_at = ?, lock_version = lock_version + 1
        WHERE id = ? AND kind = 'PUBLICATION_APPROVAL' AND status = 'OPEN'
          AND lock_version = ? AND candidate_hash = ?
      `)
      .run(
        input.approve ? 'APPROVED' : 'REJECTED',
        input.response ?? null,
        now,
        now,
        input.interruptId,
        input.expectedLockVersion,
        input.candidateHash,
      );
    if (result.changes !== 1) {
      throw new DevelopmentConflictError(`publication approval ${input.interruptId} changed`);
    }
  }

  private insertEvent(runId: number, generation: number, event: DevelopmentEventInput): number {
    const observedAt = event.observedAt ?? new Date().toISOString();
    const sequence = Number(
      (
        this.database
          .prepare(
            'SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM development_events WHERE run_id = ?',
          )
          .get(runId) as { sequence: number }
      ).sequence,
    );
    const result = this.database
      .prepare(`
        INSERT INTO development_events (
          run_id, sequence, generation, attempt_id, type, source, trust,
          idempotency_key, payload_json, observed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        runId,
        sequence,
        generation,
        event.attemptId ?? null,
        event.type,
        event.source,
        event.trust,
        event.idempotencyKey ?? null,
        JSON.stringify(event.payload ?? {}),
        observedAt,
        observedAt,
      );
    return Number(result.lastInsertRowid);
  }
}

interface DevelopmentRunRow {
  id: number;
  repository: string;
  phase: DevelopmentPhase;
  prior_phase: DevelopmentPhase | null;
  generation: number;
  lock_version: number;
  accepted_work_revision_id: number;
  revision: number;
  goal: string;
  candidate_hash: string | null;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
}

interface DevelopmentAttemptRow {
  id: number;
  run_id: number;
  work_revision_id: number;
  phase: DevelopmentPhase;
  attempt: number;
  generation: number;
  state: DevelopmentAttempt['state'];
  lease_owner: string | null;
  lease_expires_at: string | null;
}

function mapRun(row: DevelopmentRunRow): DevelopmentRun {
  return {
    id: Number(row.id),
    repository: row.repository,
    phase: row.phase,
    ...(row.prior_phase === null ? {} : { priorPhase: row.prior_phase }),
    generation: Number(row.generation),
    lockVersion: Number(row.lock_version),
    workRevisionId: Number(row.accepted_work_revision_id),
    revision: Number(row.revision),
    goal: row.goal,
    ...(row.candidate_hash === null ? {} : { candidateHash: row.candidate_hash }),
    lastActivityAt: row.last_activity_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: DevelopmentAttemptRow): DevelopmentAttempt {
  return {
    id: Number(row.id),
    runId: Number(row.run_id),
    workRevisionId: Number(row.work_revision_id),
    phase: row.phase,
    attempt: Number(row.attempt),
    generation: Number(row.generation),
    state: row.state,
    ...(row.lease_owner === null ? {} : { leaseOwner: row.lease_owner }),
    ...(row.lease_expires_at === null ? {} : { leaseExpiresAt: row.lease_expires_at }),
  };
}
