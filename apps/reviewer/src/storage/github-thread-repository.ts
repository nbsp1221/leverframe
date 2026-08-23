import type { DatabaseSync } from 'node:sqlite';
import type { ReviewResult } from '../review/result.js';
import { redactFailureExcerpt } from './failure.js';

export type ThreadResolutionState =
  | 'OPEN'
  | 'RESOLUTION_FAILED'
  | 'RESOLUTION_PENDING'
  | 'RESOLVED';

export interface PendingThreadResolution {
  attempt: number;
  evidence: string;
  fingerprint: string;
  headSha: string;
  id: number;
  installationId: number;
  jobId: number;
  pullRequestNumber: number;
  repository: string;
  threadNodeId: string;
}

export interface FindingThreadStatus {
  fingerprint: string;
  lastError?: string;
  resolutionState: ThreadResolutionState;
  resolvedAt?: string;
  resolvedHeadSha?: string;
  threadNodeId: string;
}

export class GitHubThreadRepository {
  constructor(private readonly database: DatabaseSync) {}

  recordAssociation(input: {
    commentNodeId: string;
    fingerprint: string;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    reviewDatabaseId: string;
    threadNodeId: string;
  }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO github_finding_threads (
          repository, pull_request_number, fingerprint, publication_job_id,
          review_database_id, thread_node_id, comment_node_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(publication_job_id, fingerprint) DO UPDATE SET
          review_database_id=excluded.review_database_id,
          thread_node_id=excluded.thread_node_id,
          comment_node_id=excluded.comment_node_id,
          updated_at=excluded.updated_at
      `)
      .run(
        input.repository,
        input.pullRequestNumber,
        input.fingerprint,
        input.jobId,
        input.reviewDatabaseId,
        input.threadNodeId,
        input.commentNodeId,
        now,
        now,
      );
  }

  queueFixedFindings(input: {
    headSha: string;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    updates: NonNullable<ReviewResult['finding_updates']>;
  }): number {
    const now = new Date().toISOString();
    const queue = this.database.prepare(`
      UPDATE github_finding_threads
      SET resolution_state='RESOLUTION_PENDING', resolved_by_job_id=?, resolved_head_sha=?,
          resolution_evidence=?, resolution_attempts=0, next_resolution_at=?, last_error=NULL,
          updated_at=?
      WHERE resolution_state='OPEN' AND id=(
        SELECT id FROM github_finding_threads
        WHERE repository=? AND pull_request_number=? AND fingerprint=?
        ORDER BY id DESC LIMIT 1
      )
    `);
    let queued = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const update of input.updates) {
        if (update.status !== 'fixed') {
          continue;
        }
        queued += Number(
          queue.run(
            input.jobId,
            input.headSha,
            redactFailureExcerpt(update.evidence),
            now,
            now,
            input.repository,
            input.pullRequestNumber,
            update.fingerprint,
          ).changes,
        );
      }
      this.database.exec('COMMIT');
      return queued;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  nextPendingResolution(jobId?: number): PendingThreadResolution | undefined {
    const row = this.database
      .prepare(`
        SELECT threads.*, jobs.installation_id, jobs.head_sha
        FROM github_finding_threads AS threads
        JOIN review_jobs AS jobs ON jobs.id=threads.resolved_by_job_id
        WHERE threads.resolution_state='RESOLUTION_PENDING'
          AND (threads.next_resolution_at IS NULL OR threads.next_resolution_at <= ?)
          AND (? IS NULL OR threads.resolved_by_job_id=?)
        ORDER BY threads.next_resolution_at, threads.id
        LIMIT 1
      `)
      .get(new Date().toISOString(), jobId ?? null, jobId ?? null) as
      | Record<string, unknown>
      | undefined;
    if (row === undefined) {
      return undefined;
    }
    return {
      attempt: Number(row.resolution_attempts),
      evidence: String(row.resolution_evidence),
      fingerprint: String(row.fingerprint),
      headSha: String(row.head_sha),
      id: Number(row.id),
      installationId: Number(row.installation_id),
      jobId: Number(row.resolved_by_job_id),
      pullRequestNumber: Number(row.pull_request_number),
      repository: String(row.repository),
      threadNodeId: String(row.thread_node_id),
    };
  }

  markResolved(input: { id: number; resolutionCommentNodeId?: string; resolvedAt?: string }): void {
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_state='RESOLVED', resolution_comment_node_id=COALESCE(?,resolution_comment_node_id),
            resolved_at=?, next_resolution_at=NULL, last_error=NULL, updated_at=?
        WHERE id=? AND resolution_state IN ('RESOLUTION_PENDING','RESOLVED')
      `)
      .run(input.resolutionCommentNodeId ?? null, resolvedAt, resolvedAt, input.id);
  }

  markRetry(input: { id: number; error: string; delayMilliseconds: number }): void {
    const now = new Date();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_attempts=resolution_attempts+1, next_resolution_at=?, last_error=?, updated_at=?
        WHERE id=? AND resolution_state='RESOLUTION_PENDING'
      `)
      .run(
        new Date(now.getTime() + input.delayMilliseconds).toISOString(),
        input.error.slice(0, 4_000),
        now.toISOString(),
        input.id,
      );
  }

  markFailed(input: { id: number; error: string }): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_state='RESOLUTION_FAILED', resolution_attempts=resolution_attempts+1,
            next_resolution_at=NULL, last_error=?, updated_at=?
        WHERE id=? AND resolution_state='RESOLUTION_PENDING'
      `)
      .run(input.error.slice(0, 4_000), now, input.id);
  }

  listStatuses(repository: string, pullRequestNumber: number): FindingThreadStatus[] {
    const rows = this.database
      .prepare(`
        SELECT current.* FROM github_finding_threads AS current
        WHERE current.repository=? AND current.pull_request_number=?
          AND current.id=(
            SELECT MAX(latest.id) FROM github_finding_threads AS latest
            WHERE latest.repository=current.repository
              AND latest.pull_request_number=current.pull_request_number
              AND latest.fingerprint=current.fingerprint
          )
        ORDER BY current.id
      `)
      .all(repository, pullRequestNumber) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      fingerprint: String(row.fingerprint),
      ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
      resolutionState: String(row.resolution_state) as ThreadResolutionState,
      ...(typeof row.resolved_at === 'string' ? { resolvedAt: row.resolved_at } : {}),
      ...(typeof row.resolved_head_sha === 'string'
        ? { resolvedHeadSha: row.resolved_head_sha }
        : {}),
      threadNodeId: String(row.thread_node_id),
    }));
  }
}
