import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './connection.js';
import {
  type DevelopmentClarificationQuestion,
  type RequestClarificationInput,
  type ResolveClarificationInput,
  parseClarificationContext,
  requestClarification,
  resolveClarification,
} from './development-clarification-repository.js';
import {
  type DevelopmentAttemptRow,
  type DevelopmentRunRow,
  mapDevelopmentAttempt,
  mapDevelopmentRun,
} from './development-mappers.js';
import { type DevelopmentPhase, developmentPhaseTransitions } from './development-phases.js';
import {
  type DevelopmentPullRequestReference,
  findRunByPullRequest,
  getPullRequestReference,
} from './development-pull-request-repository.js';

export type { DevelopmentPhase } from './development-phases.js';

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
  threadId?: string;
  turnId?: string;
}

export class DevelopmentConflictError extends Error {}

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
    return row === undefined ? undefined : mapDevelopmentRun(row);
  }

  listRuns(): DevelopmentRun[] {
    return (
      this.database
        .prepare(`
          SELECT r.*, w.revision, w.goal
          FROM development_runs r
          JOIN development_work_revisions w ON w.id = r.accepted_work_revision_id
          ORDER BY r.last_activity_at DESC, r.id DESC
        `)
        .all() as unknown as DevelopmentRunRow[]
    ).map(mapDevelopmentRun);
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
    return transaction(this.database, () => this.transitionWithinTransaction(input));
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
      if (run.phase !== input.phase) {
        throw new DevelopmentConflictError(
          `cannot claim ${input.phase} while development run is ${run.phase}`,
        );
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
    return mapDevelopmentAttempt(row);
  }

  findActiveAttempt(runId: number): DevelopmentAttempt | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM development_attempts WHERE run_id = ? AND state IN ('CLAIMED','RUNNING','WAITING') ORDER BY id DESC LIMIT 1",
      )
      .get(runId) as DevelopmentAttemptRow | undefined;
    return row === undefined ? undefined : mapDevelopmentAttempt(row);
  }

  findLatestThreadId(runId: number): string | undefined {
    const row = this.database
      .prepare(
        'SELECT thread_id FROM development_attempts WHERE run_id = ? AND thread_id IS NOT NULL ORDER BY id DESC LIMIT 1',
      )
      .get(runId) as { thread_id: string } | undefined;
    return row?.thread_id;
  }

  attachAttemptRuntime(input: {
    id: number;
    generation: number;
    leaseOwner: string;
    threadId: string;
    turnId?: string;
    state?: 'RUNNING' | 'WAITING';
    now?: string;
  }): DevelopmentAttempt {
    const now = input.now ?? new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE development_attempts SET
          thread_id = ?, turn_id = COALESCE(?, turn_id), state = ?, updated_at = ?
        WHERE id = ? AND generation = ? AND lease_owner = ?
          AND state IN ('CLAIMED','RUNNING','WAITING')
      `)
      .run(
        input.threadId,
        input.turnId ?? null,
        input.state ?? 'RUNNING',
        now,
        input.id,
        input.generation,
        input.leaseOwner,
      );
    if (result.changes !== 1) {
      throw new DevelopmentConflictError(`development attempt ${input.id} changed`);
    }
    return this.requireAttempt(input.id);
  }

  completeAttempt(input: {
    id: number;
    runId: number;
    generation: number;
    leaseOwner: string;
    state: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'LOST';
    outcomeCode: string;
    outcomeExcerpt?: string;
    now?: string;
  }): DevelopmentAttempt {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const result = this.database
        .prepare(`
          UPDATE development_attempts SET
            state = ?, outcome_code = ?, outcome_excerpt = ?, lease_owner = NULL,
            lease_expires_at = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND run_id = ? AND generation = ? AND lease_owner = ?
            AND state IN ('CLAIMED','RUNNING','WAITING')
        `)
        .run(
          input.state,
          input.outcomeCode,
          input.outcomeExcerpt ?? null,
          now,
          now,
          input.id,
          input.runId,
          input.generation,
          input.leaseOwner,
        );
      if (result.changes !== 1) {
        throw new DevelopmentConflictError(`development attempt ${input.id} changed`);
      }
      this.insertEvent(input.runId, input.generation, {
        type: 'attempt_completed',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
        attemptId: input.id,
        payload: { outcome_code: input.outcomeCode, state: input.state },
        observedAt: now,
      });
      return this.requireAttempt(input.id);
    });
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

  listEvents(
    runId: number,
    afterSequence = 0,
  ): Array<{
    sequence: number;
    generation: number;
    type: string;
    source: DevelopmentEventInput['source'];
    trust: DevelopmentEventInput['trust'];
    payload: Record<string, unknown>;
    observedAt: string;
  }> {
    const rows = this.database
      .prepare(`
        SELECT sequence, generation, type, source, trust, payload_json, observed_at
        FROM development_events
        WHERE run_id = ? AND sequence > ?
        ORDER BY sequence
        LIMIT 1000
      `)
      .all(runId, afterSequence) as unknown as Array<{
      sequence: number;
      generation: number;
      type: string;
      source: DevelopmentEventInput['source'];
      trust: DevelopmentEventInput['trust'];
      payload_json: string;
      observed_at: string;
    }>;
    return rows.map((row) => ({
      sequence: Number(row.sequence),
      generation: Number(row.generation),
      type: row.type,
      source: row.source,
      trust: row.trust,
      payload: JSON.parse(row.payload_json) as Record<string, unknown>,
      observedAt: row.observed_at,
    }));
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
    return transaction(this.database, () =>
      this.openPublicationApprovalWithinTransaction({ ...input, now }),
    );
  }

  requestPublicationApproval(input: {
    runId: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    workRevisionId: number;
    candidateHash: string;
    publicationKind: 'PUSH_AND_PR' | 'PUSH_EXISTING';
    prompt: string;
    now?: string;
  }): DevelopmentRun {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      this.openPublicationApprovalWithinTransaction({
        ...input,
        generation: input.expectedGeneration,
        now,
      });
      return this.transitionWithinTransaction({
        id: input.runId,
        expectedGeneration: input.expectedGeneration,
        expectedLockVersion: input.expectedLockVersion,
        phase: 'AWAITING_PUBLICATION_APPROVAL',
        event: {
          type: 'publication_approval_required',
          source: 'LEVERFRAME',
          trust: 'SYSTEM_OBSERVED',
          payload: { candidate_hash: input.candidateHash },
          observedAt: now,
        },
      });
    });
  }

  openPlanApproval(input: {
    runId: number;
    workRevisionId: number;
    generation: number;
    prompt: string;
    now?: string;
  }): number {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () =>
      this.openPlanApprovalWithinTransaction({ ...input, now }),
    );
  }

  requestClarification(input: RequestClarificationInput): number {
    return requestClarification(this.database, input, {
      conflict: (message) => new DevelopmentConflictError(message),
      requireRun: (id) => this.requireRun(id),
      requireAttempt: (id) => this.requireAttempt(id),
      transition: (transitionInput) => this.transitionWithinTransaction(transitionInput),
    });
  }

  resolveClarification(input: ResolveClarificationInput): DevelopmentRun {
    return resolveClarification(this.database, input, {
      conflict: (message) => new DevelopmentConflictError(message),
      requireRun: (id) => this.requireRun(id),
      transition: (transitionInput) => this.transitionWithinTransaction(transitionInput),
    });
  }

  requestPlanApproval(input: {
    runId: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    workRevisionId: number;
    prompt: string;
    now?: string;
  }): DevelopmentRun {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      this.openPlanApprovalWithinTransaction({
        ...input,
        generation: input.expectedGeneration,
        now,
      });
      return this.transitionWithinTransaction({
        id: input.runId,
        expectedGeneration: input.expectedGeneration,
        expectedLockVersion: input.expectedLockVersion,
        phase: 'AWAITING_PLAN_APPROVAL',
        event: {
          type: 'plan_approval_required',
          source: 'LEVERFRAME',
          trust: 'SYSTEM_OBSERVED',
          observedAt: now,
        },
      });
    });
  }

  resolvePlanApproval(input: {
    interruptId: number;
    expectedLockVersion: number;
    approve: boolean;
    response?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    const result = this.database
      .prepare(`
        UPDATE development_interrupts SET
          status = ?, response = ?, resolved_at = ?, updated_at = ?, lock_version = lock_version + 1
        WHERE id = ? AND kind = 'PLAN_APPROVAL' AND status = 'OPEN' AND lock_version = ?
      `)
      .run(
        input.approve ? 'APPROVED' : 'REJECTED',
        input.response ?? null,
        now,
        now,
        input.interruptId,
        input.expectedLockVersion,
      );
    if (result.changes !== 1) {
      throw new DevelopmentConflictError(`plan approval ${input.interruptId} changed`);
    }
  }

  getOpenInterrupt(runId: number):
    | {
        id: number;
        kind: 'CLARIFICATION' | 'PLAN_APPROVAL' | 'PUBLICATION_APPROVAL';
        prompt: string;
        lockVersion: number;
        candidateHash?: string;
        publicationKind?: 'PUSH_AND_PR' | 'PUSH_EXISTING';
        requestedAt: string;
        questions?: DevelopmentClarificationQuestion[];
      }
    | undefined {
    const row = this.database
      .prepare(`
        SELECT id, kind, prompt, context_json, lock_version, candidate_hash, publication_kind, requested_at
        FROM development_interrupts WHERE run_id = ? AND status = 'OPEN'
      `)
      .get(runId) as
      | {
          id: number;
          kind: 'CLARIFICATION' | 'PLAN_APPROVAL' | 'PUBLICATION_APPROVAL';
          prompt: string;
          context_json: string;
          lock_version: number;
          candidate_hash: string | null;
          publication_kind: 'PUSH_AND_PR' | 'PUSH_EXISTING' | null;
          requested_at: string;
        }
      | undefined;
    return row === undefined
      ? undefined
      : {
          id: Number(row.id),
          kind: row.kind,
          prompt: row.prompt,
          lockVersion: Number(row.lock_version),
          requestedAt: row.requested_at,
          ...(row.kind === 'CLARIFICATION'
            ? { questions: parseClarificationContext(row.context_json).questions }
            : {}),
          ...(row.candidate_hash === null ? {} : { candidateHash: row.candidate_hash }),
          ...(row.publication_kind === null ? {} : { publicationKind: row.publication_kind }),
        };
  }

  listEvidence(runId: number): Array<{
    id: number;
    criterion: string;
    method: 'COMMAND' | 'BROWSER' | 'INSPECTION' | 'EXTERNAL_OBSERVATION';
    observation: string;
    trust: DevelopmentEventInput['trust'];
    verdict: 'PASSED' | 'FAILED' | 'UNRESOLVED';
    candidateHash: string;
    createdAt: string;
  }> {
    return (
      this.database
        .prepare(`
          SELECT id, criterion, method, observation, trust, verdict, candidate_hash, created_at
          FROM development_evidence WHERE run_id = ? ORDER BY id
        `)
        .all(runId) as unknown as Array<{
        id: number;
        criterion: string;
        method: 'COMMAND' | 'BROWSER' | 'INSPECTION' | 'EXTERNAL_OBSERVATION';
        observation: string;
        trust: DevelopmentEventInput['trust'];
        verdict: 'PASSED' | 'FAILED' | 'UNRESOLVED';
        candidate_hash: string;
        created_at: string;
      }>
    ).map((row) => ({
      id: Number(row.id),
      criterion: row.criterion,
      method: row.method,
      observation: row.observation,
      trust: row.trust,
      verdict: row.verdict,
      candidateHash: row.candidate_hash,
      createdAt: row.created_at,
    }));
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

  decidePublicationApproval(input: {
    runId: number;
    interruptId: number;
    expectedInterruptLockVersion: number;
    expectedGeneration: number;
    expectedRunLockVersion: number;
    candidateHash: string;
    approve: boolean;
    response?: string;
    now?: string;
  }): DevelopmentRun {
    const now = input.now ?? new Date().toISOString();
    return transaction(this.database, () => {
      const resolved = this.database
        .prepare(`
          UPDATE development_interrupts SET
            status = ?, response = ?, resolved_at = ?, updated_at = ?, lock_version = lock_version + 1
          WHERE id = ? AND run_id = ? AND kind = 'PUBLICATION_APPROVAL' AND status = 'OPEN'
            AND lock_version = ? AND generation = ? AND candidate_hash = ?
        `)
        .run(
          input.approve ? 'APPROVED' : 'REJECTED',
          input.response ?? null,
          now,
          now,
          input.interruptId,
          input.runId,
          input.expectedInterruptLockVersion,
          input.expectedGeneration,
          input.candidateHash,
        );
      if (resolved.changes !== 1) {
        throw new DevelopmentConflictError(`publication approval ${input.interruptId} changed`);
      }
      return this.transitionWithinTransaction({
        id: input.runId,
        expectedGeneration: input.expectedGeneration,
        expectedLockVersion: input.expectedRunLockVersion,
        phase: input.approve ? 'PUBLISHING' : 'IMPLEMENTING',
        advanceGeneration: true,
        event: {
          type: input.approve ? 'publication_approved' : 'publication_rejected',
          source: 'HUMAN',
          trust: 'HUMAN_DECIDED',
          payload: { candidate_hash: input.candidateHash },
          observedAt: now,
        },
      });
    });
  }

  recordPullRequest(input: {
    runId: number;
    generation: number;
    number: number;
    url: string;
    headSha: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    transaction(this.database, () => {
      const run = this.requireRun(input.runId);
      if (run.generation !== input.generation || run.phase !== 'PUBLISHING') {
        throw new DevelopmentConflictError(
          `pull request observation for run ${input.runId} is stale`,
        );
      }
      this.database
        .prepare(`
          INSERT INTO development_external_refs (
            run_id, provider, kind, external_id, external_key, url, observation_json,
            observed_at, created_at, updated_at
          ) VALUES (?, 'github', 'PULL_REQUEST', ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id, provider, kind) DO UPDATE SET
            external_id = excluded.external_id, external_key = excluded.external_key,
            url = excluded.url, observation_json = excluded.observation_json,
            observed_at = excluded.observed_at, updated_at = excluded.updated_at
        `)
        .run(
          input.runId,
          String(input.number),
          `#${input.number}`,
          input.url,
          JSON.stringify({ head_sha: input.headSha, state: 'open' }),
          now,
          now,
          now,
        );
      this.insertEvent(input.runId, input.generation, {
        type: 'pull_request_observed',
        source: 'GITHUB',
        trust: 'SYSTEM_OBSERVED',
        payload: { number: input.number, url: input.url, head_sha: input.headSha },
        observedAt: now,
      });
    });
  }

  getPullRequestReference(runId: number): DevelopmentPullRequestReference | undefined {
    return getPullRequestReference(this.database, runId);
  }

  findRunByPullRequest(input: {
    repository: string;
    pullRequestNumber: number;
  }): DevelopmentRun | undefined {
    return findRunByPullRequest(this.database, input);
  }

  private transitionWithinTransaction(input: {
    id: number;
    expectedGeneration: number;
    expectedLockVersion: number;
    phase: DevelopmentPhase;
    priorPhase?: DevelopmentPhase;
    advanceGeneration?: boolean;
    event: DevelopmentEventInput;
  }): DevelopmentRun {
    const current = this.requireRun(input.id);
    const isWaitingResume =
      current.phase === 'WAITING_FOR_INPUT' && current.priorPhase === input.phase;
    if (!isWaitingResume && !developmentPhaseTransitions[current.phase].includes(input.phase)) {
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
  }

  private openPlanApprovalWithinTransaction(input: {
    runId: number;
    workRevisionId: number;
    generation: number;
    prompt: string;
    now: string;
  }): number {
    const run = this.requireRun(input.runId);
    if (run.generation !== input.generation || run.workRevisionId !== input.workRevisionId) {
      throw new DevelopmentConflictError(`plan revision for run ${input.runId} is stale`);
    }
    const result = this.database
      .prepare(`
        INSERT INTO development_interrupts (
          run_id, work_revision_id, generation, kind, status, prompt, context_json,
          requested_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'PLAN_APPROVAL', 'OPEN', ?, '{}', ?, ?, ?)
      `)
      .run(
        input.runId,
        input.workRevisionId,
        input.generation,
        input.prompt,
        input.now,
        input.now,
        input.now,
      );
    return Number(result.lastInsertRowid);
  }

  private openPublicationApprovalWithinTransaction(input: {
    runId: number;
    workRevisionId: number;
    generation: number;
    candidateHash: string;
    publicationKind: 'PUSH_AND_PR' | 'PUSH_EXISTING';
    prompt: string;
    context?: Record<string, unknown>;
    now: string;
  }): number {
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
        input.now,
        input.now,
        input.now,
      );
    return Number(result.lastInsertRowid);
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
