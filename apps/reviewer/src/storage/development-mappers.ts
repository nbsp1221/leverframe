import type {
  DevelopmentAttempt,
  DevelopmentPhase,
  DevelopmentRun,
} from './development-repository.js';

export interface DevelopmentRunRow {
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

export interface DevelopmentAttemptRow {
  id: number;
  run_id: number;
  work_revision_id: number;
  phase: DevelopmentPhase;
  attempt: number;
  generation: number;
  state: DevelopmentAttempt['state'];
  lease_owner: string | null;
  lease_expires_at: string | null;
  thread_id: string | null;
  turn_id: string | null;
}

export function mapDevelopmentRun(row: DevelopmentRunRow): DevelopmentRun {
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

export function mapDevelopmentAttempt(row: DevelopmentAttemptRow): DevelopmentAttempt {
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
    ...(row.thread_id === null ? {} : { threadId: row.thread_id }),
    ...(row.turn_id === null ? {} : { turnId: row.turn_id }),
  };
}
