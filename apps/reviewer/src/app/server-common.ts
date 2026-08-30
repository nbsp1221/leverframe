import type {
  DevelopmentRepository,
  dependencyStatusSchema,
  reviewStatusSchema,
} from '@repo/contracts';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { z } from 'zod';
import { errorResponseSchema, evaluationHistorySchema, reviewDetailSchema } from '@repo/contracts';
import type { ManualCommand } from '../jobs/command.js';
import type {
  JobDatabase,
  PullRequestCancellationInput,
  PullRequestJobInput,
} from '../jobs/database.js';
import { findingFingerprint } from '../review/result.js';
import { EvaluationConflictError } from '../storage/evaluation-repository.js';

export const pageSize = 20 as const;
export const historyLimit = 100;

export type Dependency = 'api' | 'database' | 'worker' | 'sandbox' | 'github';

export type Observation = {
  status: z.infer<typeof dependencyStatusSchema>;
  last_observed_at: string | null;
  detail: string | null;
};

export type Observations = Record<Dependency, Observation>;

export interface ServerHooks {
  isSandboxAvailable?: () => boolean | Promise<boolean>;
  isWorkerRunning?: () => boolean | Promise<boolean>;
  onJobQueued?: (job: PullRequestJobInput) => void;
  onManualCommand?: (command: ManualCommand) => Promise<{ status: string }>;
  onPullRequestCancelled?: (cancellation: PullRequestCancellationInput) => void;
  onDevelopmentRunCreated?: (runId: number) => void;
  listDevelopmentRepositories?: () => Promise<readonly DevelopmentRepository[]>;
  validateDevelopmentRepository?: (repository: string) => Promise<boolean>;
  onDevelopmentClarificationAnswer?: (input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    answers: Record<string, string[]>;
  }) => void;
  onDevelopmentPlanApproval?: (input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    approve: boolean;
    response?: string;
  }) => void;
  onDevelopmentPublicationApproval?: (input: {
    runId: number;
    interruptId: number;
    interruptLockVersion: number;
    candidateHash: string;
    approve: boolean;
    response?: string;
  }) => void;
  /** Optional bounded context adapter. It must never return credentials or an entire diff. */
  getFindingContext?: (input: {
    repository: string;
    installationId: number;
    baseSha: string;
    headSha: string;
    file: string;
    line: number;
  }) => Promise<{ content: string; startLine: number; endLine: number } | undefined>;
}

export function createObservations(): Observations {
  return Object.fromEntries(
    (['api', 'database', 'worker', 'sandbox', 'github'] as const).map((name) => [
      name,
      { status: 'unknown', last_observed_at: null, detail: null },
    ]),
  ) as Observations;
}

export function json<T, S extends ContentfulStatusCode = 200>(
  c: Context,
  body: T,
  status: S = 200 as S,
) {
  return c.json(body, status);
}

export function apiError<S extends ContentfulStatusCode>(
  c: Context,
  status: S,
  error: string,
  code?: string,
  details?: unknown,
) {
  const value = errorResponseSchema.parse({
    error,
    ...(code === undefined ? {} : { code }),
    ...(details === undefined ? {} : { details }),
  });
  return json(c, value, status);
}

export function positiveId(value: string | string[] | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export function mapStatus(state: string): z.infer<typeof reviewStatusSchema> {
  const normalized = state.toLowerCase();
  if (normalized === 'done') {
    return 'completed';
  }
  if (
    ['checking_out', 'sandbox_creating', 'reviewing', 'validating', 'publishing'].includes(
      normalized,
    )
  ) {
    return 'running';
  }
  if (normalized === 'timed_out') {
    return 'failed';
  }
  if (['queued', 'failed', 'cancelled', 'superseded'].includes(normalized)) {
    return normalized as ReturnType<typeof mapStatus>;
  }
  return 'unknown';
}

export function mapEvaluation(
  value: ReturnType<JobDatabase['getCurrentEvaluation']>,
): Record<string, unknown> | null {
  if (value === undefined) {
    return null;
  }
  return {
    id: value.id,
    target_type: value.targetType,
    finding_fingerprint: value.findingFingerprint ?? null,
    verdict: value.verdict ?? null,
    rationale: value.rationale ?? null,
    source: value.source,
    action: value.action,
    supersedes_id: value.supersedesId ?? null,
    created_at: value.createdAt,
  };
}

export function isoOrNull(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
}

export function evaluationError(c: Context, error: unknown) {
  if (error instanceof EvaluationConflictError) {
    return apiError(
      c,
      409,
      error.message,
      'STALE_EVALUATION',
      error.current === undefined ? undefined : mapEvaluation(error.current),
    );
  }
  const message = error instanceof Error ? error.message : 'invalid evaluation';
  if (message.includes('not found') || message.includes('does not exist')) {
    return apiError(c, 422, message, 'INVALID_TARGET');
  }
  if (message.includes('completed') || message.includes('available')) {
    return apiError(c, 422, message, 'INVALID_STATE');
  }
  return apiError(c, 422, message, 'INVALID_EVALUATION');
}

export function evaluationHistory(
  database: JobDatabase,
  id: number,
  target: 'review' | 'finding',
  fingerprint?: string,
) {
  const all = database.getEvaluationHistory(id, target, fingerprint);
  const truncated = all.length > historyLimit;
  const history = all
    .slice(-historyLimit)
    .reverse()
    .map(mapEvaluation)
    .filter((value): value is Record<string, unknown> => value !== null);
  const latest = all.at(-1);
  const current = latest?.action === 'set' ? mapEvaluation(latest) : null;
  return evaluationHistorySchema.parse({ current, history, truncated });
}

export function detailResponse(c: Context, database: JobDatabase, id: number) {
  if (!Number.isSafeInteger(id) || id <= 0) {
    return apiError(c, 422, 'invalid review id', 'INVALID_ID');
  }
  const job = database.getReviewJob(id);
  if (job === undefined) {
    return apiError(c, 404, 'review not found', 'NOT_FOUND');
  }
  const artifact = database.getReviewArtifact(id);
  const lifecycle = artifact?.result;
  const known = new Map(
    database
      .getReviewFindings(job.repository, job.pullRequestNumber)
      .map((finding) => [finding.fingerprint, finding]),
  );
  const threadStatuses = new Map(
    database
      .getFindingThreadStatuses(job.repository, job.pullRequestNumber)
      .map((status) => [status.fingerprint, status]),
  );
  const findings =
    lifecycle?.findings.map((finding) => {
      const fingerprint = findingFingerprint(finding);
      const threadStatus = threadStatuses.get(fingerprint);
      return {
        fingerprint,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
        explanation: finding.explanation,
        suggested_action: finding.suggested_action,
        evidence: finding.evidence,
        file: finding.file,
        line: finding.line,
        state: known.get(fingerprint)?.state.toLowerCase() ?? null,
        thread_resolution:
          threadStatus === undefined
            ? null
            : {
                state: mapThreadResolutionState(threadStatus.resolutionState),
                resolved_at: threadStatus.resolvedAt ?? null,
                resolved_head_sha: threadStatus.resolvedHeadSha ?? null,
                last_error: threadStatus.lastError ?? null,
              },
        evaluation: database.getCurrentEvaluation(id, 'finding', fingerprint)?.verdict ?? null,
      };
    }) ?? [];
  const response = reviewDetailSchema.parse({
    id: job.id,
    repository: job.repository,
    pull_request_number: job.pullRequestNumber,
    pull_request_title: job.pullRequestTitle ?? null,
    head_sha: job.headSha,
    base_sha: job.baseSha ?? null,
    installation_id: job.installationId,
    action: job.action,
    status: mapStatus(job.state),
    attempt: job.attempt ?? null,
    model: job.model ?? null,
    reasoning: job.reasoning ?? null,
    prompt_version: job.promptVersion ?? null,
    prompt_hash: job.promptHash ?? null,
    schema_version: job.schemaVersion ?? null,
    schema_hash: job.schemaHash ?? null,
    created_at: job.createdAt,
    review_started_at: isoOrNull(job.reviewStartedAt),
    review_completed_at: isoOrNull(job.reviewCompletedAt),
    publication_started_at: isoOrNull(job.publicationStartedAt),
    published_at: isoOrNull(job.publishedAt),
    published_review_id: job.publishedReviewId ?? null,
    error_code: job.errorCode ?? null,
    error_excerpt: job.errorExcerpt ?? null,
    superseded_by_job_id: job.supersededByJobId ?? null,
    artifact: {
      available: artifact?.available === true,
      content_hash: artifact?.contentHash ?? null,
      unavailable_reason:
        artifact?.unavailableReason ?? (artifact === undefined ? 'MISSING' : null),
      summary: lifecycle?.summary ?? null,
      findings,
      coverage: lifecycle?.coverage ?? null,
      limitations: lifecycle?.limitations ?? [],
      tests_run: lifecycle?.tests_run ?? [],
    },
    review_evaluation: mapEvaluation(database.getCurrentEvaluation(id, 'review')),
  });
  return json(c, response);
}

function mapThreadResolutionState(
  state: 'OPEN' | 'RESOLUTION_FAILED' | 'RESOLUTION_PENDING' | 'RESOLVED',
): 'failed' | 'open' | 'pending' | 'resolved' {
  switch (state) {
    case 'OPEN':
      return 'open';
    case 'RESOLUTION_PENDING':
      return 'pending';
    case 'RESOLVED':
      return 'resolved';
    case 'RESOLUTION_FAILED':
      return 'failed';
  }
}
