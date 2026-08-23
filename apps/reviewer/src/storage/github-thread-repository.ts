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

export interface PendingThreadAssociation {
  attempt: number;
  expectedFingerprints: ReadonlySet<string>;
  installationId: number;
  jobId: number;
  pullRequestNumber: number;
  repository: string;
  reviewDatabaseId: number;
}

export interface FindingThreadStatus {
  fingerprint: string;
  lastError?: string;
  resolutionState: ThreadResolutionState;
  resolvedAt?: string;
  resolvedHeadSha?: string;
  threadNodeId?: string;
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
    this.database.exec('BEGIN IMMEDIATE');
    try {
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
      this.#queueAssociatedFixedFinding(input, now);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  queueAssociation(input: {
    expectedFingerprints: readonly string[];
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    reviewDatabaseId: number;
  }): void {
    if (input.expectedFingerprints.length === 0) {
      this.completeAssociation(input.jobId);
      return;
    }
    const now = new Date().toISOString();
    this.database
      .prepare(`
        INSERT INTO github_thread_association_intents (
          job_id, repository, pull_request_number, review_database_id,
          expected_fingerprints_json, state, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)
        ON CONFLICT(job_id) DO UPDATE SET
          expected_fingerprints_json=excluded.expected_fingerprints_json,
          state=CASE WHEN state='COMPLETED' THEN state ELSE 'PENDING' END,
          next_attempt_at=CASE WHEN state='COMPLETED' THEN next_attempt_at ELSE excluded.next_attempt_at END,
          last_error=CASE WHEN state='COMPLETED' THEN last_error ELSE NULL END,
          updated_at=excluded.updated_at
      `)
      .run(
        input.jobId,
        input.repository,
        input.pullRequestNumber,
        String(input.reviewDatabaseId),
        JSON.stringify([...new Set(input.expectedFingerprints)]),
        now,
        now,
        now,
      );
  }

  nextPendingAssociation(): PendingThreadAssociation | undefined {
    const row = this.database
      .prepare(`
        SELECT intents.*, jobs.installation_id
        FROM github_thread_association_intents AS intents
        JOIN review_jobs AS jobs ON jobs.id=intents.job_id
        WHERE intents.state IN ('PENDING','FAILED')
          AND (intents.next_attempt_at IS NULL OR intents.next_attempt_at <= ?)
        ORDER BY intents.next_attempt_at, intents.job_id
        LIMIT 1
      `)
      .get(new Date().toISOString()) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    const parsed = JSON.parse(String(row.expected_fingerprints_json)) as unknown;
    if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
      throw new Error(`invalid association fingerprints for job ${String(row.job_id)}`);
    }
    return {
      attempt: Number(row.attempts),
      expectedFingerprints: new Set(parsed),
      installationId: Number(row.installation_id),
      jobId: Number(row.job_id),
      pullRequestNumber: Number(row.pull_request_number),
      repository: String(row.repository),
      reviewDatabaseId: Number(row.review_database_id),
    };
  }

  remainingAssociationFingerprints(jobId: number): string[] {
    const row = this.database
      .prepare(
        `SELECT expected_fingerprints_json FROM github_thread_association_intents WHERE job_id=?`,
      )
      .get(jobId) as { expected_fingerprints_json: string } | undefined;
    if (row === undefined) {
      return [];
    }
    const expected = JSON.parse(row.expected_fingerprints_json) as string[];
    const associated = new Set(
      (
        this.database
          .prepare(`SELECT fingerprint FROM github_finding_threads WHERE publication_job_id=?`)
          .all(jobId) as Array<{ fingerprint: string }>
      ).map((item) => item.fingerprint),
    );
    return expected.filter((fingerprint) => !associated.has(fingerprint));
  }

  completeAssociation(jobId: number): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`
        UPDATE github_thread_association_intents
        SET state='COMPLETED', next_attempt_at=NULL, last_error=NULL,
            completed_at=?, updated_at=?
        WHERE job_id=? AND state IN ('PENDING','FAILED')
      `)
      .run(now, now, jobId);
  }

  retryAssociation(input: { jobId: number; error: string; delayMilliseconds: number }): void {
    const now = new Date();
    this.database
      .prepare(`
        UPDATE github_thread_association_intents
        SET state='PENDING', attempts=attempts+1, next_attempt_at=?, last_error=?, updated_at=?
        WHERE job_id=? AND state IN ('PENDING','FAILED')
      `)
      .run(
        new Date(now.getTime() + input.delayMilliseconds).toISOString(),
        input.error.slice(0, 4_000),
        now.toISOString(),
        input.jobId,
      );
  }

  failAssociation(input: { jobId: number; error: string; retryDelayMilliseconds: number }): void {
    const now = new Date();
    this.database
      .prepare(`
        UPDATE github_thread_association_intents
        SET state='FAILED', attempts=attempts+1, next_attempt_at=?, last_error=?, updated_at=?
        WHERE job_id=? AND state IN ('PENDING','FAILED')
      `)
      .run(
        new Date(now.getTime() + input.retryDelayMilliseconds).toISOString(),
        input.error.slice(0, 4_000),
        now.toISOString(),
        input.jobId,
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
      WHERE resolution_state IN ('OPEN','RESOLUTION_FAILED','RESOLUTION_PENDING')
        AND (resolved_by_job_id IS NULL OR resolved_by_job_id <= ?)
        AND id=(
        SELECT id FROM github_finding_threads
        WHERE repository=? AND pull_request_number=? AND fingerprint=?
        ORDER BY publication_job_id DESC, id DESC LIMIT 1
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
            input.jobId,
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
        WHERE threads.resolution_state IN ('RESOLUTION_PENDING','RESOLUTION_FAILED')
          AND jobs.state='DONE'
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

  markResolved(input: {
    id: number;
    jobId: number;
    resolutionCommentNodeId?: string;
    resolvedAt?: string;
  }): void {
    const resolvedAt = input.resolvedAt ?? new Date().toISOString();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_state='RESOLVED', resolution_comment_node_id=COALESCE(?,resolution_comment_node_id),
            resolved_at=?, next_resolution_at=NULL, last_error=NULL, updated_at=?
        WHERE id=? AND resolved_by_job_id=?
          AND resolution_state IN ('RESOLUTION_PENDING','RESOLUTION_FAILED','RESOLVED')
      `)
      .run(input.resolutionCommentNodeId ?? null, resolvedAt, resolvedAt, input.id, input.jobId);
  }

  markRetry(input: { id: number; jobId: number; error: string; delayMilliseconds: number }): void {
    const now = new Date();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_attempts=resolution_attempts+1, next_resolution_at=?, last_error=?, updated_at=?
        WHERE id=? AND resolved_by_job_id=?
          AND resolution_state IN ('RESOLUTION_PENDING','RESOLUTION_FAILED')
      `)
      .run(
        new Date(now.getTime() + input.delayMilliseconds).toISOString(),
        input.error.slice(0, 4_000),
        now.toISOString(),
        input.id,
        input.jobId,
      );
  }

  markFailed(input: {
    id: number;
    jobId: number;
    error: string;
    retryDelayMilliseconds: number;
  }): void {
    const now = new Date();
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_state='RESOLUTION_FAILED', resolution_attempts=resolution_attempts+1,
            next_resolution_at=?, last_error=?, updated_at=?
        WHERE id=? AND resolved_by_job_id=?
          AND resolution_state IN ('RESOLUTION_PENDING','RESOLUTION_FAILED')
      `)
      .run(
        new Date(now.getTime() + input.retryDelayMilliseconds).toISOString(),
        input.error.slice(0, 4_000),
        now.toISOString(),
        input.id,
        input.jobId,
      );
  }

  listStatuses(repository: string, pullRequestNumber: number): FindingThreadStatus[] {
    const rows = this.database
      .prepare(`
        SELECT current.* FROM github_finding_threads AS current
        WHERE current.repository=? AND current.pull_request_number=?
          AND current.id=(
            SELECT latest.id FROM github_finding_threads AS latest
            WHERE latest.repository=current.repository
              AND latest.pull_request_number=current.pull_request_number
              AND latest.fingerprint=current.fingerprint
            ORDER BY latest.publication_job_id DESC, latest.id DESC LIMIT 1
          )
        ORDER BY current.id
      `)
      .all(repository, pullRequestNumber) as Array<Record<string, unknown>>;
    const statuses: FindingThreadStatus[] = rows.map((row) => ({
      fingerprint: String(row.fingerprint),
      ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
      resolutionState: String(row.resolution_state) as ThreadResolutionState,
      ...(typeof row.resolved_at === 'string' ? { resolvedAt: row.resolved_at } : {}),
      ...(typeof row.resolved_head_sha === 'string'
        ? { resolvedHeadSha: row.resolved_head_sha }
        : {}),
      threadNodeId: String(row.thread_node_id),
    }));
    const knownFingerprints = new Set(statuses.map((status) => status.fingerprint));
    const associationRows = this.database
      .prepare(`
        SELECT expected_fingerprints_json, state, last_error
        FROM github_thread_association_intents
        WHERE repository=? AND pull_request_number=? AND state IN ('PENDING','FAILED')
        ORDER BY job_id DESC
      `)
      .all(repository, pullRequestNumber) as Array<Record<string, unknown>>;
    for (const row of associationRows) {
      const fingerprints = JSON.parse(String(row.expected_fingerprints_json)) as string[];
      for (const fingerprint of fingerprints) {
        if (knownFingerprints.has(fingerprint)) {
          continue;
        }
        statuses.push({
          fingerprint,
          ...(typeof row.last_error === 'string' ? { lastError: row.last_error } : {}),
          resolutionState: row.state === 'FAILED' ? 'RESOLUTION_FAILED' : 'RESOLUTION_PENDING',
        });
        knownFingerprints.add(fingerprint);
      }
    }
    return statuses;
  }

  #queueAssociatedFixedFinding(
    input: { fingerprint: string; jobId: number; pullRequestNumber: number; repository: string },
    now: string,
  ): void {
    const fixed = this.database
      .prepare(`
        SELECT findings.evidence, findings.last_seen_job_id, jobs.head_sha
        FROM review_findings AS findings
        JOIN review_jobs AS jobs ON jobs.id=findings.last_seen_job_id
        WHERE findings.repository=? AND findings.pull_request_number=?
          AND findings.fingerprint=? AND findings.state='FIXED'
      `)
      .get(input.repository, input.pullRequestNumber, input.fingerprint) as
      | { evidence: string; head_sha: string; last_seen_job_id: number }
      | undefined;
    if (fixed === undefined) {
      return;
    }
    this.database
      .prepare(`
        UPDATE github_finding_threads
        SET resolution_state='RESOLUTION_PENDING', resolved_by_job_id=?, resolved_head_sha=?,
            resolution_evidence=?, resolution_attempts=0, next_resolution_at=?,
            last_error=NULL, updated_at=?
        WHERE publication_job_id=? AND fingerprint=?
          AND resolution_state IN ('OPEN','RESOLUTION_FAILED','RESOLUTION_PENDING')
          AND (resolved_by_job_id IS NULL OR resolved_by_job_id <= ?)
      `)
      .run(
        Number(fixed.last_seen_job_id),
        String(fixed.head_sha),
        redactFailureExcerpt(String(fixed.evidence)),
        now,
        now,
        input.jobId,
        input.fingerprint,
        Number(fixed.last_seen_job_id),
      );
  }
}
