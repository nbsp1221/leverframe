import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ReviewResult } from '../review/result.js';
import { openDatabase } from '../storage/connection.js';
import {
  EvaluationRepository,
  type EvaluationRevision,
  type EvaluationTarget,
  type FindingVerdict,
  type ReviewVerdict,
} from '../storage/evaluation-repository.js';
import { redactFailureExcerpt } from '../storage/failure.js';
import {
  type FindingThreadStatus,
  GitHubThreadRepository,
  type PendingThreadAssociation,
  type PendingThreadResolution,
} from '../storage/github-thread-repository.js';
import { runMigrations, schemaVersion } from '../storage/migrations/index.js';
import {
  type PreviousReview,
  type ReviewArtifact,
  type ReviewFinding,
  ReviewRepository,
} from '../storage/review-repository.js';
import type { ManualCommand } from './command.js';

export interface PullRequestJobInput {
  action: string;
  deliveryId: string;
  headSha: string;
  installationId: number;
  policyVersion: string;
  pullRequestNumber: number;
  repository: string;
  baseSha?: string;
  pullRequestTitle?: string;
  model?: string;
  reasoning?: string;
  promptVersion?: string;
  promptHash?: string;
  schemaVersion?: string;
  schemaHash?: string;
}

export interface EnqueueResult {
  deliveryAccepted: boolean;
  jobCreated: boolean;
  jobsSuperseded: number;
}

export interface PullRequestCancellationInput {
  action: 'closed' | 'converted_to_draft';
  deliveryId: string;
  headSha: string;
  installationId: number;
  pullRequestNumber: number;
  repository: string;
}

export interface CancellationResult {
  deliveryAccepted: boolean;
  jobsCancelled: number;
}

export interface ReviewJob extends PullRequestJobInput {
  /**
   * Monotonically increasing claim/revival token used to reject stale worker
   * updates. Jobs created before this column existed are assigned zero and
   * receive their first token when claimed.
   */
  attempt?: number;
  checkRunId: number | undefined;
  id: number;
  publishedReviewId: number | undefined;
  resultPath: string | undefined;
  state: string;
  baseSha?: string;
  pullRequestTitle?: string;
  model?: string;
  reasoning?: string;
  promptVersion?: string;
  promptHash?: string;
  schemaVersion?: string;
  schemaHash?: string;
  errorCode?: string;
  errorExcerpt?: string;
  artifactHash?: string;
}

export type {
  EvaluationRevision,
  EvaluationTarget,
  FindingVerdict,
  ReviewVerdict,
} from '../storage/evaluation-repository.js';
export { EvaluationConflictError } from '../storage/evaluation-repository.js';

export interface PullRequestState {
  currentHeadSha: string;
  currentJobId: number;
  statusCommentId: number | undefined;
}

export type {
  PreviousReview,
  ReviewArtifact,
  ReviewFinding,
} from '../storage/review-repository.js';

export interface LatestJobStatus {
  error: string | undefined;
  headSha: string;
  id: number;
  state: string;
}

export interface ReviewQuery {
  page: number;
  sort?: 'created' | 'completed';
  query?: string;
  statuses?: readonly string[];
  evaluation?: 'evaluated' | 'needs_evaluation';
}

export interface ReviewQueryRow {
  id: number;
  repository: string;
  pullRequestNumber: number;
  pullRequestTitle?: string;
  headSha: string;
  baseSha?: string;
  state: string;
  model?: string;
  reasoning?: string;
  findingsCount: number;
  highestSeverity: string | undefined;
  reviewEvaluationId?: number;
  reviewVerdict?: ReviewVerdict;
  evaluatedFindings: number;
  totalFindings: number;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs: number | undefined;
}

export interface ReviewDetailRow extends ReviewJob {
  createdAt: string;
  reviewStartedAt?: string;
  reviewCompletedAt?: string;
  publicationStartedAt?: string;
  publishedAt?: string;
  supersededByJobId?: number;
}

export class JobDatabase {
  readonly #database: DatabaseSync;
  readonly #evaluationRepository: EvaluationRepository;
  readonly #githubThreadRepository: GitHubThreadRepository;
  readonly #reviewRepository: ReviewRepository;

  constructor(path: string, options: { dataRoot?: string } = {}) {
    const dataRoot = resolve(
      options.dataRoot ?? (path === ':memory:' ? process.cwd() : dirname(path)),
    );
    this.#database = openDatabase(path);
    runMigrations(this.#database);
    this.#reviewRepository = new ReviewRepository(this.#database, dataRoot);
    this.#githubThreadRepository = new GitHubThreadRepository(this.#database);
    this.#evaluationRepository = new EvaluationRepository(this.#database, (jobId) =>
      this.getReviewArtifact(jobId),
    );
    this.#reviewRepository.backfillArtifacts();
    this.#database.exec(`
      UPDATE review_jobs
      SET state = 'QUEUED', updated_at = datetime('now')
      WHERE state IN ('CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING')
    `);
  }

  close(): void {
    this.#database.close();
  }

  getSchemaVersion(): number {
    return schemaVersion(this.#database);
  }

  enqueuePullRequest(input: PullRequestJobInput): EnqueueResult {
    const now = new Date().toISOString();
    const insertDelivery = this.#database.prepare(`
      INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at)
      VALUES (?, ?)
    `);
    const insertJob = this.#database.prepare(`
      INSERT OR IGNORE INTO review_jobs (
        repository,
        pull_request_number,
        head_sha,
        policy_version,
        installation_id,
        action,
        delivery_id,
        created_at,
        updated_at,
        base_sha, pull_request_title, model, reasoning, prompt_version, prompt_hash,
        schema_version, schema_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const reviveJob = this.#database.prepare(`
      UPDATE review_jobs
      SET installation_id = ?, action = ?, delivery_id = ?, state = 'QUEUED',
          attempt = attempt + 1,
          error = NULL, check_run_id = NULL, result_path = NULL,
          published_review_id = NULL,
          base_sha = NULL, pull_request_title = NULL,
          model = NULL, reasoning = NULL,
          prompt_version = NULL, prompt_hash = NULL,
          schema_version = NULL, schema_hash = NULL,
          review_started_at = NULL, review_completed_at = NULL,
          publication_started_at = NULL, published_at = NULL,
          superseded_by_job_id = NULL,
          error_code = NULL, error_excerpt = NULL, artifact_hash = NULL,
          created_at = ?, updated_at = ?
      WHERE repository = ?
        AND pull_request_number = ?
        AND head_sha = ?
        AND policy_version = ?
        AND state IN ('CANCELLED', 'SUPERSEDED')
      RETURNING id
    `);
    const supersedeOlderQueuedJobs = this.#database.prepare(`
      UPDATE review_jobs
      SET state = 'SUPERSEDED', updated_at = ?
      WHERE repository = ?
        AND pull_request_number = ?
        AND state = 'QUEUED'
        AND NOT (head_sha = ? AND policy_version = ?)
    `);

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const delivery = insertDelivery.run(input.deliveryId, now);
      if (delivery.changes === 0) {
        this.#database.exec('COMMIT');
        return { deliveryAccepted: false, jobCreated: false, jobsSuperseded: 0 };
      }

      const insertedJob = insertJob.run(
        input.repository,
        input.pullRequestNumber,
        input.headSha,
        input.policyVersion,
        input.installationId,
        input.action,
        input.deliveryId,
        now,
        now,
        input.baseSha ?? null,
        input.pullRequestTitle ?? null,
        input.model ?? null,
        input.reasoning ?? null,
        input.promptVersion ?? null,
        input.promptHash ?? null,
        input.schemaVersion ?? null,
        input.schemaHash ?? null,
      );
      const revivedJob =
        insertedJob.changes === 0
          ? (reviveJob.get(
              input.installationId,
              input.action,
              input.deliveryId,
              now,
              now,
              input.repository,
              input.pullRequestNumber,
              input.headSha,
              input.policyVersion,
            ) as { id: number } | undefined)
          : undefined;
      if (revivedJob !== undefined) {
        this.#database.prepare('DELETE FROM review_artifacts WHERE job_id = ?').run(revivedJob.id);
      }
      const jobCreated = insertedJob.changes === 1 || revivedJob !== undefined;
      const superseded = jobCreated
        ? supersedeOlderQueuedJobs.run(
            now,
            input.repository,
            input.pullRequestNumber,
            input.headSha,
            input.policyVersion,
          )
        : { changes: 0 };
      this.#database.exec('COMMIT');
      return {
        deliveryAccepted: true,
        jobCreated,
        jobsSuperseded: Number(superseded.changes),
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  cancelPullRequest(input: PullRequestCancellationInput): CancellationResult {
    const now = new Date().toISOString();
    const reason =
      input.action === 'closed' ? 'Pull request closed.' : 'Pull request converted to draft.';

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const delivery = this.#database
        .prepare(`
          INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at)
          VALUES (?, ?)
        `)
        .run(input.deliveryId, now);
      if (delivery.changes === 0) {
        this.#database.exec('COMMIT');
        return { deliveryAccepted: false, jobsCancelled: 0 };
      }

      const cancelled = this.#database
        .prepare(`
          UPDATE review_jobs
          SET state = 'CANCELLED', error = ?, updated_at = ?
          WHERE repository = ?
            AND pull_request_number = ?
            AND state IN (
              'QUEUED',
              'CHECKING_OUT',
              'SANDBOX_CREATING',
              'REVIEWING',
              'VALIDATING',
              'PUBLISHING'
            )
        `)
        .run(reason, now, input.repository, input.pullRequestNumber);
      this.#database.exec('COMMIT');
      return {
        deliveryAccepted: true,
        jobsCancelled: Number(cancelled.changes),
      };
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  countJobs(): number {
    const row = this.#database.prepare('SELECT COUNT(*) AS count FROM review_jobs').get() as {
      count: number;
    };
    return row.count;
  }

  isAvailable(): boolean {
    try {
      this.#database.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  listReviewJobs(input: ReviewQuery): { items: ReviewQueryRow[]; totalItems: number } {
    const { items: rows, totalItems } = this.#reviewRepository.listReviewJobs(input);
    return {
      totalItems,
      items: rows.map((row) => {
        const findingsCount = Number(row.findings_count ?? 0);
        return {
          id: Number(row.id),
          repository: String(row.repository),
          pullRequestNumber: Number(row.pull_request_number),
          ...(typeof row.pull_request_title === 'string'
            ? { pullRequestTitle: row.pull_request_title }
            : {}),
          headSha: String(row.head_sha),
          ...(typeof row.base_sha === 'string' ? { baseSha: row.base_sha } : {}),
          state: String(row.state),
          ...(typeof row.model === 'string' ? { model: row.model } : {}),
          ...(typeof row.reasoning === 'string' ? { reasoning: row.reasoning } : {}),
          findingsCount,
          evaluatedFindings: Number(row.evaluated_findings ?? 0),
          totalFindings: findingsCount,
          ...(typeof row.review_evaluation_id === 'number'
            ? { reviewEvaluationId: Number(row.review_evaluation_id) }
            : {}),
          ...reviewVerdictFromRow(row.review_verdict),
          createdAt: String(row.created_at),
          ...(typeof row.review_started_at === 'string'
            ? { startedAt: row.review_started_at }
            : {}),
          ...(typeof row.review_completed_at === 'string'
            ? { completedAt: row.review_completed_at }
            : {}),
          durationMs: durationMilliseconds(row.review_started_at, row.review_completed_at),
          highestSeverity: highestSeverity(
            row.result_json,
            row.availability,
            row.content_hash,
            row.artifact_hash,
          ),
        };
      }),
    };
  }

  getReviewJob(id: number): ReviewDetailRow | undefined {
    const row = this.#reviewRepository.getReviewJobRow(id);
    if (row === undefined) {
      return undefined;
    }
    const job = mapReviewJob(row);
    return {
      ...job,
      createdAt: String(row.created_at),
      ...(typeof row.review_started_at === 'string'
        ? { reviewStartedAt: row.review_started_at }
        : {}),
      ...(typeof row.review_completed_at === 'string'
        ? { reviewCompletedAt: row.review_completed_at }
        : {}),
      ...(typeof row.publication_started_at === 'string'
        ? { publicationStartedAt: row.publication_started_at }
        : {}),
      ...(typeof row.published_at === 'string' ? { publishedAt: row.published_at } : {}),
      ...(row.superseded_by_job_id === null || row.superseded_by_job_id === undefined
        ? {}
        : { supersededByJobId: Number(row.superseded_by_job_id) }),
    };
  }

  getActiveJobIds(): Set<number> {
    const rows = this.#database
      .prepare(`
        SELECT id FROM review_jobs
        WHERE state IN (
          'CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING'
        )
      `)
      .all() as Array<{ id: number }>;
    return new Set(rows.map((row) => Number(row.id)));
  }

  getActiveJobStages(): Record<string, number> {
    const rows = this.#database
      .prepare(`
        SELECT state, COUNT(*) AS count FROM review_jobs
        WHERE state IN (
          'QUEUED', 'CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING'
        )
        GROUP BY state
      `)
      .all() as Array<{ state: string; count: number }>;
    return Object.fromEntries(
      rows.map((row) => [String(row.state).toLowerCase(), Number(row.count)]),
    );
  }

  acceptManualCommand(command: ManualCommand): boolean {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(`
        INSERT OR IGNORE INTO command_audits (
          delivery_id, repository, pull_request_number, comment_id,
          actor, command, outcome, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?)
      `)
      .run(
        command.deliveryId,
        command.repository,
        command.pullRequestNumber,
        command.commentId,
        command.actor,
        command.command,
        now,
        now,
      );
    if (result.changes === 1) {
      return true;
    }
    const retried = this.#database
      .prepare(`
        UPDATE command_audits
        SET outcome = 'RECEIVED', detail = NULL, updated_at = ?
        WHERE delivery_id = ? AND outcome = 'FAILED'
      `)
      .run(now, command.deliveryId);
    return retried.changes === 1;
  }

  completeManualCommand(deliveryId: string, outcome: string, detail?: string): void {
    this.#database
      .prepare(`
        UPDATE command_audits
        SET outcome = ?, detail = ?, updated_at = ?
        WHERE delivery_id = ?
      `)
      .run(outcome, detail ?? null, new Date().toISOString(), deliveryId);
  }

  cancelActiveJobs(repository: string, pullRequestNumber: number, reason: string): number {
    const result = this.#database
      .prepare(`
        UPDATE review_jobs
        SET state = 'CANCELLED', error = ?, updated_at = ?
        WHERE repository = ? AND pull_request_number = ?
          AND state IN (
            'QUEUED', 'CHECKING_OUT', 'SANDBOX_CREATING',
            'REVIEWING', 'VALIDATING', 'PUBLISHING'
          )
      `)
      .run(reason, new Date().toISOString(), repository, pullRequestNumber);
    return Number(result.changes);
  }

  /**
   * Put work interrupted by service shutdown back into the durable queue.
   * Incrementing the attempt invalidates any asynchronous work that is still
   * unwinding and leaves check/publication identities available for retry.
   */
  requeueActiveJobs(): number {
    const result = this.#database
      .prepare(`
        UPDATE review_jobs
        SET state = 'QUEUED', error = NULL, attempt = attempt + 1, updated_at = ?
        WHERE state IN (
          'CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING'
        )
      `)
      .run(new Date().toISOString());
    return Number(result.changes);
  }

  getLatestJobStatus(repository: string, pullRequestNumber: number): LatestJobStatus | undefined {
    const row = this.#database
      .prepare(`
        SELECT id, head_sha, state, error
        FROM review_jobs
        WHERE repository = ? AND pull_request_number = ?
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(repository, pullRequestNumber) as Record<string, unknown> | undefined;
    return row === undefined
      ? undefined
      : {
          error: typeof row.error === 'string' ? row.error : undefined,
          headSha: String(row.head_sha),
          id: Number(row.id),
          state: String(row.state),
        };
  }

  findPreviousCompletedReview(job: ReviewJob): PreviousReview | undefined {
    return this.#reviewRepository.findPreviousCompletedReview(job);
  }

  reconcileFindings(input: {
    job: ReviewJob;
    previousResult: ReviewResult | undefined;
    result: ReviewResult;
  }): void {
    this.#reviewRepository.reconcileFindings(input);
  }

  getReviewFindings(repository: string, pullRequestNumber: number): ReviewFinding[] {
    return this.#reviewRepository.getReviewFindings(repository, pullRequestNumber);
  }

  recordGitHubThreadAssociation(input: {
    commentNodeId: string;
    fingerprint: string;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    reviewDatabaseId: string;
    threadNodeId: string;
  }): void {
    this.#githubThreadRepository.recordAssociation(input);
  }

  queueGitHubThreadAssociation(input: {
    expectedFingerprints: readonly string[];
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    reviewDatabaseId: number;
  }): void {
    this.#githubThreadRepository.queueAssociation(input);
  }

  nextPendingGitHubThreadAssociation(): PendingThreadAssociation | undefined {
    return this.#githubThreadRepository.nextPendingAssociation();
  }

  remainingGitHubThreadAssociationFingerprints(jobId: number): string[] {
    return this.#githubThreadRepository.remainingAssociationFingerprints(jobId);
  }

  completeGitHubThreadAssociation(jobId: number): void {
    this.#githubThreadRepository.completeAssociation(jobId);
  }

  retryGitHubThreadAssociation(input: {
    jobId: number;
    error: string;
    delayMilliseconds: number;
  }): void {
    this.#githubThreadRepository.retryAssociation(input);
  }

  failGitHubThreadAssociation(input: {
    jobId: number;
    error: string;
    retryDelayMilliseconds: number;
  }): void {
    this.#githubThreadRepository.failAssociation(input);
  }

  queueFixedFindingResolutions(input: {
    headSha: string;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    updates: NonNullable<ReviewResult['finding_updates']>;
  }): number {
    return this.#githubThreadRepository.queueFixedFindings(input);
  }

  nextPendingThreadResolution(jobId?: number): PendingThreadResolution | undefined {
    return this.#githubThreadRepository.nextPendingResolution(jobId);
  }

  markThreadResolved(input: {
    id: number;
    resolutionCommentNodeId?: string;
    resolvedAt?: string;
  }): void {
    this.#githubThreadRepository.markResolved(input);
  }

  retryThreadResolution(input: { id: number; error: string; delayMilliseconds: number }): void {
    this.#githubThreadRepository.markRetry(input);
  }

  failThreadResolution(input: { id: number; error: string; retryDelayMilliseconds: number }): void {
    this.#githubThreadRepository.markFailed(input);
  }

  getFindingThreadStatuses(repository: string, pullRequestNumber: number): FindingThreadStatus[] {
    return this.#githubThreadRepository.listStatuses(repository, pullRequestNumber);
  }

  activatePullRequestJob(job: ReviewJob): PullRequestState {
    const row = this.#database
      .prepare(`
        INSERT INTO pull_request_state (
          repository,
          pull_request_number,
          current_job_id,
          current_head_sha,
          updated_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(repository, pull_request_number) DO UPDATE SET
          current_job_id = excluded.current_job_id,
          current_head_sha = excluded.current_head_sha,
          updated_at = excluded.updated_at
        RETURNING *
      `)
      .get(
        job.repository,
        job.pullRequestNumber,
        job.id,
        job.headSha,
        new Date().toISOString(),
      ) as Record<string, unknown>;

    return mapPullRequestState(row);
  }

  attachStatusComment(input: {
    attempt?: number;
    commentId: number;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
  }): boolean {
    const conditions = ['repository = ?', 'pull_request_number = ?', 'current_job_id = ?'];
    const parameters: Array<number | string> = [
      input.repository,
      input.pullRequestNumber,
      input.jobId,
    ];
    if (input.attempt !== undefined) {
      conditions.push(
        'EXISTS (SELECT 1 FROM review_jobs WHERE id = current_job_id AND attempt = ?)',
      );
      parameters.push(input.attempt);
    }
    const result = this.#database
      .prepare(`
        UPDATE pull_request_state
        SET status_comment_id = ?, updated_at = ?
        WHERE ${conditions.join(' AND ')}
      `)
      .run(input.commentId, new Date().toISOString(), ...parameters);
    return result.changes === 1;
  }

  isCurrentPullRequestJob(input: {
    attempt?: number;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
  }): boolean {
    const row = this.#database
      .prepare(`
        SELECT state.current_job_id, jobs.attempt
        FROM pull_request_state AS state
        JOIN review_jobs AS jobs ON jobs.id = state.current_job_id
        WHERE state.repository = ? AND state.pull_request_number = ?
      `)
      .get(input.repository, input.pullRequestNumber) as
      | { attempt: number; current_job_id: number }
      | undefined;
    return (
      row?.current_job_id === input.jobId &&
      (input.attempt === undefined || row.attempt === input.attempt)
    );
  }

  isJobAttemptCurrent(input: { attempt: number; jobId: number }): boolean {
    const row = this.#database
      .prepare('SELECT attempt FROM review_jobs WHERE id = ?')
      .get(input.jobId) as { attempt: number } | undefined;
    return row?.attempt === input.attempt;
  }

  claimNextJob(): ReviewJob | undefined {
    const row = this.#database
      .prepare(`
        UPDATE review_jobs
        SET state = 'CHECKING_OUT', attempt = attempt + 1, updated_at = ?
        WHERE id = (
          SELECT id FROM review_jobs
          WHERE state = 'QUEUED'
            AND NOT EXISTS (
              SELECT 1
              FROM review_jobs AS newer
              WHERE newer.repository = review_jobs.repository
                AND newer.pull_request_number = review_jobs.pull_request_number
                AND newer.state = 'QUEUED'
                AND newer.id > review_jobs.id
            )
          ORDER BY id
          LIMIT 1
        )
        RETURNING *
      `)
      .get(new Date().toISOString()) as Record<string, unknown> | undefined;

    return row === undefined ? undefined : mapReviewJob(row);
  }

  updateJob(input: {
    checkRunId?: number;
    error?: string | null;
    errorCode?: string | null;
    errorExcerpt?: string | null;
    attempt?: number;
    expectedStates?: readonly string[];
    id: number;
    publishedReviewId?: number;
    resultPath?: string;
    state: string;
  }): boolean {
    const conditions = ['id = ?'];
    const rawError = input.error ?? null;
    const parameters: Array<number | string | null> = [
      input.state,
      rawError === null ? null : (redactFailureExcerpt(rawError).split('\n', 1)[0] ?? ''),
      input.checkRunId ?? null,
      input.resultPath ?? null,
      input.publishedReviewId ?? null,
      new Date().toISOString(),
      input.id,
    ];
    if (input.attempt !== undefined) {
      conditions.push('attempt = ?');
      parameters.push(input.attempt);
    }
    if (input.expectedStates !== undefined && input.expectedStates.length > 0) {
      conditions.push(`state IN (${input.expectedStates.map(() => '?').join(', ')})`);
      parameters.push(...input.expectedStates);
    }
    const excerpt =
      input.errorExcerpt ?? (rawError === null ? null : redactFailureExcerpt(rawError));
    const code = input.errorCode ?? (rawError === null ? null : 'UNKNOWN');
    const result = this.#database
      .prepare(`
        UPDATE review_jobs
        SET state = ?, error = ?, check_run_id = COALESCE(?, check_run_id),
            result_path = COALESCE(?, result_path),
            published_review_id = COALESCE(?, published_review_id), error_code = COALESCE(?, error_code),
            error_excerpt = COALESCE(?, error_excerpt), updated_at = ?
        WHERE ${conditions.join(' AND ')}
      `)
      .run(
        ...[
          parameters[0],
          parameters[1],
          parameters[2],
          parameters[3],
          parameters[4],
          code,
          excerpt,
          parameters[5],
          parameters[6],
          ...parameters.slice(7),
        ].map((value) => value ?? null),
      );
    const changed = Number(result.changes) === 1;
    if (changed) {
      const now = new Date().toISOString();
      if (input.state === 'REVIEWING') {
        this.#database
          .prepare(
            'UPDATE review_jobs SET review_started_at=COALESCE(review_started_at,?) WHERE id=?',
          )
          .run(now, input.id);
      } else if (input.state === 'VALIDATING') {
        this.#database
          .prepare(
            'UPDATE review_jobs SET review_completed_at=COALESCE(review_completed_at,?) WHERE id=?',
          )
          .run(now, input.id);
      } else if (input.state === 'PUBLISHING') {
        this.#database
          .prepare(
            'UPDATE review_jobs SET publication_started_at=COALESCE(publication_started_at,?) WHERE id=?',
          )
          .run(now, input.id);
      } else if (input.state === 'DONE') {
        this.#database
          .prepare('UPDATE review_jobs SET published_at=COALESCE(published_at,?) WHERE id=?')
          .run(now, input.id);
      }
    }
    return changed;
  }

  recordReviewMetadata(input: {
    jobId: number;
    baseSha?: string;
    pullRequestTitle?: string;
    model?: string;
    reasoning?: string;
    promptVersion?: string;
    prompt?: string;
    schemaVersion?: string;
    schema?: string;
  }): void {
    this.#reviewRepository.recordReviewMetadata(input);
  }

  recordReviewArtifact(jobId: number, result: ReviewResult, schemaVersion?: string): string {
    return this.#reviewRepository.recordReviewArtifact(jobId, result, schemaVersion);
  }

  getReviewArtifact(jobId: number): ReviewArtifact | undefined {
    return this.#reviewRepository.getReviewArtifact(jobId);
  }

  setEvaluation(input: {
    jobId: number;
    targetType: EvaluationTarget;
    findingFingerprint?: string;
    verdict: ReviewVerdict | FindingVerdict;
    rationale?: string;
    expectedPreviousId: number | null;
  }): EvaluationRevision {
    return this.#evaluationRepository.setEvaluation(input);
  }

  withdrawEvaluation(input: {
    jobId: number;
    targetType: EvaluationTarget;
    findingFingerprint?: string;
    expectedPreviousId: number | null;
  }): EvaluationRevision {
    return this.#evaluationRepository.withdrawEvaluation(input);
  }

  getEvaluationHistory(
    jobId: number,
    targetType: EvaluationTarget,
    findingFingerprint?: string,
  ): EvaluationRevision[] {
    return this.#evaluationRepository.getEvaluationHistory(jobId, targetType, findingFingerprint);
  }

  getCurrentEvaluation(
    jobId: number,
    targetType: EvaluationTarget,
    findingFingerprint?: string,
  ): EvaluationRevision | undefined {
    return this.#evaluationRepository.getCurrentEvaluation(jobId, targetType, findingFingerprint);
  }
}

function mapReviewJob(row: Record<string, unknown>): ReviewJob {
  const job: ReviewJob = {
    action: String(row.action),
    attempt: Number(row.attempt ?? 0),
    deliveryId: String(row.delivery_id),
    checkRunId:
      row.check_run_id === null || row.check_run_id === undefined
        ? undefined
        : Number(row.check_run_id),
    headSha: String(row.head_sha),
    id: Number(row.id),
    installationId: Number(row.installation_id),
    policyVersion: String(row.policy_version),
    publishedReviewId:
      row.published_review_id === null || row.published_review_id === undefined
        ? undefined
        : Number(row.published_review_id),
    pullRequestNumber: Number(row.pull_request_number),
    repository: String(row.repository),
    resultPath:
      row.result_path === null || row.result_path === undefined
        ? undefined
        : typeof row.result_path === 'string'
          ? row.result_path
          : undefined,
    state: String(row.state),
  };
  const optional = {
    ...(typeof row.base_sha === 'string' ? { baseSha: row.base_sha } : {}),
    ...(typeof row.pull_request_title === 'string'
      ? { pullRequestTitle: row.pull_request_title }
      : {}),
    ...(typeof row.model === 'string' ? { model: row.model } : {}),
    ...(typeof row.reasoning === 'string' ? { reasoning: row.reasoning } : {}),
    ...(typeof row.prompt_version === 'string' ? { promptVersion: row.prompt_version } : {}),
    ...(typeof row.prompt_hash === 'string' ? { promptHash: row.prompt_hash } : {}),
    ...(typeof row.schema_version === 'string' ? { schemaVersion: row.schema_version } : {}),
    ...(typeof row.schema_hash === 'string' ? { schemaHash: row.schema_hash } : {}),
    ...(typeof row.error_code === 'string' ? { errorCode: row.error_code } : {}),
    ...(typeof row.error_excerpt === 'string' ? { errorExcerpt: row.error_excerpt } : {}),
    ...(typeof row.artifact_hash === 'string' ? { artifactHash: row.artifact_hash } : {}),
  };
  return Object.assign(job, optional);
}

function mapPullRequestState(row: Record<string, unknown>): PullRequestState {
  return {
    currentHeadSha: String(row.current_head_sha),
    currentJobId: Number(row.current_job_id),
    statusCommentId:
      row.status_comment_id === null || row.status_comment_id === undefined
        ? undefined
        : Number(row.status_comment_id),
  };
}

function durationMilliseconds(start: unknown, end: unknown): number | undefined {
  if (typeof start !== 'string' || typeof end !== 'string') {
    return undefined;
  }
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function highestSeverity(
  resultJson: unknown,
  availability: unknown,
  contentHash: unknown,
  artifactHash: unknown,
): string | undefined {
  if (
    availability !== 'AVAILABLE' ||
    typeof resultJson !== 'string' ||
    !artifactIntegrity(resultJson, contentHash, artifactHash)
  ) {
    return undefined;
  }
  try {
    const findings =
      (JSON.parse(resultJson) as { findings?: Array<{ severity?: string }> }).findings ?? [];
    for (const severity of ['critical', 'high', 'medium', 'low']) {
      if (findings.some((finding) => finding.severity === severity)) {
        return severity;
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function artifactIntegrity(
  resultJson: string,
  contentHash: unknown,
  artifactHash: unknown,
): boolean {
  if (typeof contentHash !== 'string' || typeof artifactHash !== 'string') {
    return false;
  }
  const hash = createHash('sha256').update(resultJson, 'utf8').digest('hex');
  return hash === contentHash && hash === artifactHash;
}

function reviewVerdictFromRow(
  value: unknown,
): { reviewVerdict: ReviewVerdict } | Record<string, never> {
  return value === 'useful' ||
    value === 'mixed' ||
    value === 'not_useful' ||
    value === 'unable_to_assess'
    ? { reviewVerdict: value }
    : {};
}
