import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  type DeleteEvaluationRequest,
  type FindingEvaluationWriteRequest,
  type ReviewEvaluationWriteRequest,
  contextResponseSchema,
  deleteEvaluationRequestSchema,
  errorResponseSchema,
  evaluationWriteResponseSchema,
  evaluationsResponseSchema,
  findingEvaluationWriteRequestSchema,
  findingParamsSchema,
  reviewDetailSchema,
  reviewEvaluationWriteRequestSchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
  reviewListResponseSchema,
  reviewMetricsResponseSchema,
  statusResponseSchema,
} from '@repo/contracts';
import type { JobDatabase } from '../../jobs/database.js';
import { findingFingerprint } from '../../review/result.js';
import {
  type Dependency,
  type Observation,
  type ServerHooks,
  apiError,
  detailResponse,
  evaluationError,
  evaluationHistory,
  json,
  mapEvaluation,
  mapStatus,
  pageSize,
} from '../server-common.js';

const reviewStatusMap: Record<string, string[]> = {
  running: ['CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING'],
  completed: ['DONE'],
  failed: ['FAILED', 'TIMED_OUT'],
  superseded: ['SUPERSEDED'],
  queued: ['QUEUED'],
  cancelled: ['CANCELLED'],
};

function jsonResponse(schema: ZodType, description: string) {
  return {
    description,
    content: { 'application/json': { schema } },
  } as const;
}

const notFoundResponse = jsonResponse(
  errorResponseSchema,
  'The requested review was not found. The response code is NOT_FOUND.',
);
const invalidRequestResponse = jsonResponse(
  errorResponseSchema,
  'The path, query, target, state, evaluation, or request body is invalid. The response code identifies INVALID_ID, INVALID_QUERY, INVALID_REQUEST, INVALID_VERDICT, INVALID_TARGET, INVALID_STATE, or INVALID_EVALUATION.',
);
const conflictResponse = jsonResponse(
  errorResponseSchema,
  'The evaluation changed after the client read it. The response code is STALE_EVALUATION. Read the current revision before retrying.',
);

const statusRoute = createRoute({
  method: 'get',
  path: '/api/v1/status',
  operationId: 'getLeverframeStatus',
  tags: ['Service'],
  summary: 'Get Leverframe dependency status',
  description:
    'Returns the last observed API, database, worker, sandbox, and GitHub status without probing external dependencies for every request.',
  responses: {
    200: jsonResponse(statusResponseSchema, 'The current observed service status.'),
  },
});

const listReviewsRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews',
  operationId: 'listReviews',
  tags: ['Reviews'],
  summary: 'List review runs',
  description:
    'Lists durable review runs. Use status=completed and evaluation=needs_evaluation to find completed reviews that still need an overall human-approved evaluation.',
  request: { query: reviewListQuerySchema },
  responses: {
    200: jsonResponse(reviewListResponseSchema, 'A page of review runs.'),
    422: invalidRequestResponse,
  },
});

const reviewMetricsRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/metrics',
  operationId: 'getReviewMetrics',
  tags: ['Reviews'],
  summary: 'Get recent review execution metrics',
  description:
    'Returns bounded operational metrics over the 50 most recent terminal review runs. Failure rate includes FAILED and TIMED_OUT runs and excludes CANCELLED and SUPERSEDED runs. Duration statistics use successful DONE runs with complete review timing.',
  responses: {
    200: jsonResponse(reviewMetricsResponseSchema, 'Recent review execution metrics.'),
  },
});

const getReviewRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/{reviewId}',
  operationId: 'getReview',
  tags: ['Reviews'],
  summary: 'Get a review and its artifact',
  description:
    'Returns review metadata, findings, coverage, limitations, verification evidence, and current evaluations. It does not expose a full Codex transcript, full command output, or a full diff.',
  request: { params: reviewIdParamsSchema },
  responses: {
    200: jsonResponse(reviewDetailSchema, 'The review and its bounded artifact.'),
    404: notFoundResponse,
    422: invalidRequestResponse,
  },
});

const getReviewEvaluationsRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/{reviewId}/evaluations',
  operationId: 'getReviewEvaluations',
  tags: ['Evaluations'],
  summary: 'Get current evaluations and revision history',
  description:
    'Read this endpoint before a write. Pass the current revision ID as expected_previous_id, or null only when no revision exists.',
  request: { params: reviewIdParamsSchema },
  responses: {
    200: jsonResponse(
      evaluationsResponseSchema,
      'Current review and finding evaluations with history.',
    ),
    404: notFoundResponse,
    422: invalidRequestResponse,
  },
});

const setReviewEvaluationRoute = createRoute({
  method: 'put',
  path: '/api/v1/reviews/{reviewId}/evaluation',
  operationId: 'setReviewEvaluation',
  tags: ['Evaluations'],
  summary: 'Set the overall review evaluation',
  description:
    'Record a human-approved overall judgment. Leverframe does not run or verify the approval workflow. On 409, present the current revision for renewed human review instead of silently overwriting it.',
  request: {
    params: reviewIdParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: reviewEvaluationWriteRequestSchema,
          example: {
            verdict: 'useful',
            rationale: 'The findings are reproducible and actionable.',
            expected_previous_id: null,
          },
        },
      },
    },
  },
  responses: {
    200: jsonResponse(
      evaluationWriteResponseSchema,
      'The appended revision and current evaluation.',
    ),
    404: notFoundResponse,
    409: conflictResponse,
    422: invalidRequestResponse,
  },
});

const withdrawReviewEvaluationRoute = createRoute({
  method: 'delete',
  path: '/api/v1/reviews/{reviewId}/evaluation',
  operationId: 'withdrawReviewEvaluation',
  tags: ['Evaluations'],
  summary: 'Withdraw the overall review evaluation',
  description:
    'Appends a withdrawal revision without deleting history. Supply the current revision ID to prevent overwriting a concurrent change.',
  request: {
    params: reviewIdParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: deleteEvaluationRequestSchema,
          example: { expected_previous_id: 82 },
        },
      },
    },
  },
  responses: {
    200: jsonResponse(
      evaluationWriteResponseSchema,
      'The withdrawal revision and a null current evaluation.',
    ),
    404: notFoundResponse,
    409: conflictResponse,
    422: invalidRequestResponse,
  },
});

const setFindingEvaluationRoute = createRoute({
  method: 'put',
  path: '/api/v1/reviews/{reviewId}/findings/{fingerprint}/evaluation',
  operationId: 'setFindingEvaluation',
  tags: ['Evaluations'],
  summary: 'Set a finding evaluation',
  description:
    'Record a human-approved finding judgment and evidence-based rationale. Leverframe does not run or verify the approval workflow.',
  request: {
    params: findingParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: findingEvaluationWriteRequestSchema,
          example: {
            verdict: 'false_positive',
            rationale: 'The reported branch is unreachable after caller validation.',
            expected_previous_id: 81,
          },
        },
      },
    },
  },
  responses: {
    200: jsonResponse(
      evaluationWriteResponseSchema,
      'The appended revision and current evaluation.',
    ),
    404: notFoundResponse,
    409: conflictResponse,
    422: invalidRequestResponse,
  },
});

const withdrawFindingEvaluationRoute = createRoute({
  method: 'delete',
  path: '/api/v1/reviews/{reviewId}/findings/{fingerprint}/evaluation',
  operationId: 'withdrawFindingEvaluation',
  tags: ['Evaluations'],
  summary: 'Withdraw a finding evaluation',
  description:
    'Appends a withdrawal revision without deleting finding evaluation history. Supply the current revision ID.',
  request: {
    params: findingParamsSchema,
    body: {
      required: true,
      content: {
        'application/json': {
          schema: deleteEvaluationRequestSchema,
          example: { expected_previous_id: 82 },
        },
      },
    },
  },
  responses: {
    200: jsonResponse(
      evaluationWriteResponseSchema,
      'The withdrawal revision and a null current evaluation.',
    ),
    404: notFoundResponse,
    409: conflictResponse,
    422: invalidRequestResponse,
  },
});

const getFindingContextRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/{reviewId}/findings/{fingerprint}/context',
  operationId: 'getFindingContext',
  tags: ['Reviews'],
  summary: 'Get bounded context for a finding',
  description:
    'Returns stored evidence first, or a bounded GitHub comparison snippet when available. The response never contains credentials or an entire diff.',
  request: { params: findingParamsSchema },
  responses: {
    200: jsonResponse(contextResponseSchema, 'Bounded context or an explicit unavailable result.'),
    404: notFoundResponse,
    422: invalidRequestResponse,
  },
});

export function registerReviewRoutes(
  app: OpenAPIHono,
  database: JobDatabase,
  hooks: ServerHooks,
  observations: Record<Dependency, Observation>,
  recordRead: () => void,
): void {
  app.openapi(statusRoute, (c) => {
    recordRead();
    const values = Object.values(observations).map((item) => item.status);
    const overall = values.includes('unavailable')
      ? 'unavailable'
      : values.includes('degraded')
        ? 'degraded'
        : values.includes('unknown')
          ? 'unknown'
          : 'healthy';
    const activeStages = database.getActiveJobStages();
    const response = statusResponseSchema.parse({
      overall,
      observed_at: new Date().toISOString(),
      ...observations,
      active_jobs: Object.values(activeStages).reduce((sum, count) => sum + count, 0),
      active_stages: activeStages,
    });
    return c.json(response, 200);
  });

  app.openapi(listReviewsRoute, (c) => {
    const query = c.req.valid('query');
    const statusValues =
      c.req.queries('status') ??
      (query.status === undefined
        ? []
        : Array.isArray(query.status)
          ? query.status
          : [query.status]);
    const statuses = statusValues
      .flatMap((entry) => entry.split(','))
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean);
    if (statuses.some((value) => reviewStatusMap[value] === undefined)) {
      return apiError(c, 422, 'invalid status filter', 'INVALID_QUERY');
    }
    const result = database.listReviewJobs({
      page: query.page,
      sort: query.sort,
      ...(query.query === undefined ? {} : { query: query.query }),
      ...(statuses.length === 0
        ? {}
        : { statuses: statuses.flatMap((value) => reviewStatusMap[value] ?? []) }),
      ...(query.evaluation === undefined ? {} : { evaluation: query.evaluation }),
    });
    const response = reviewListResponseSchema.parse({
      page: query.page,
      page_size: pageSize,
      total_items: result.totalItems,
      total_pages: Math.ceil(result.totalItems / pageSize),
      items: result.items.map((item) => ({
        id: item.id,
        repository: item.repository,
        pull_request_number: item.pullRequestNumber,
        pull_request_title: item.pullRequestTitle ?? null,
        head_sha: item.headSha,
        base_sha: item.baseSha ?? null,
        status: mapStatus(item.state),
        model: item.model ?? null,
        reasoning: item.reasoning ?? null,
        findings_count: item.findingsCount,
        highest_severity: item.highestSeverity ?? null,
        review_evaluation: item.reviewVerdict ?? null,
        evaluated_findings: item.evaluatedFindings,
        total_findings: item.totalFindings,
        created_at: item.createdAt,
        started_at: item.startedAt ?? null,
        completed_at: item.completedAt ?? null,
        duration_ms: item.durationMs ?? null,
      })),
    });
    recordRead();
    return c.json(response, 200);
  });

  app.openapi(reviewMetricsRoute, (c) => {
    const metrics = database.getReviewMetrics(50);
    const response = reviewMetricsResponseSchema.parse({
      terminal_window_size: metrics.terminalWindowSize,
      terminal_sample_size: metrics.terminalSampleSize,
      completed_sample_size: metrics.completedSampleSize,
      failed_sample_size: metrics.failedSampleSize,
      duration_sample_size: metrics.durationSampleSize,
      average_duration_ms: metrics.averageDurationMs ?? null,
      median_duration_ms: metrics.medianDurationMs ?? null,
      failure_rate: metrics.failureRate ?? null,
    });
    recordRead();
    return c.json(response, 200);
  });

  app.openapi(getReviewRoute, (c) => detailResponse(c, database, c.req.valid('param').reviewId));

  app.openapi(getReviewEvaluationsRoute, (c) => {
    const id = c.req.valid('param').reviewId;
    const job = database.getReviewJob(id);
    if (job === undefined) {
      return apiError(c, 404, 'review not found', 'NOT_FOUND');
    }
    const findings = database.getReviewArtifact(id)?.result?.findings ?? [];
    const result = evaluationsResponseSchema.parse({
      review: evaluationHistory(database, id, 'review'),
      findings: Object.fromEntries(
        findings.map((finding) => {
          const fingerprint = findingFingerprint(finding);
          return [fingerprint, evaluationHistory(database, id, 'finding', fingerprint)];
        }),
      ),
    });
    recordRead();
    return c.json(result, 200);
  });

  app.openapi(setReviewEvaluationRoute, (c) =>
    writeEvaluation(c, database, c.req.valid('param').reviewId, 'review', c.req.valid('json')),
  );
  app.openapi(setFindingEvaluationRoute, (c) => {
    const params = c.req.valid('param');
    return writeEvaluation(
      c,
      database,
      params.reviewId,
      'finding',
      c.req.valid('json'),
      params.fingerprint,
    );
  });

  app.openapi(withdrawReviewEvaluationRoute, (c) =>
    withdrawEvaluation(c, database, c.req.valid('param').reviewId, 'review', c.req.valid('json')),
  );
  app.openapi(withdrawFindingEvaluationRoute, (c) => {
    const params = c.req.valid('param');
    return withdrawEvaluation(
      c,
      database,
      params.reviewId,
      'finding',
      c.req.valid('json'),
      params.fingerprint,
    );
  });

  app.openapi(getFindingContextRoute, async (c) => {
    const { reviewId, fingerprint } = c.req.valid('param');
    const job = database.getReviewJob(reviewId);
    if (job === undefined) {
      return apiError(c, 404, 'review not found', 'NOT_FOUND');
    }
    const finding = database
      .getReviewArtifact(reviewId)
      ?.result?.findings.find((item) => findingFingerprint(item) === fingerprint);
    if (finding === undefined) {
      return apiError(c, 404, 'finding not found', 'NOT_FOUND');
    }
    if (finding.evidence.trim() !== '') {
      return c.json(
        contextResponseSchema.parse({
          available: true,
          source: 'stored_evidence',
          file: finding.file,
          line: finding.line,
          content: finding.evidence.slice(0, 16_384),
          start_line: finding.line,
          end_line: finding.line,
          unavailable_reason: null,
        }),
        200,
      );
    }
    if (hooks.getFindingContext !== undefined && job.baseSha !== undefined) {
      try {
        const context = await hooks.getFindingContext({
          repository: job.repository,
          installationId: job.installationId,
          baseSha: job.baseSha,
          headSha: job.headSha,
          file: finding.file,
          line: finding.line,
        });
        if (context !== undefined) {
          return c.json(
            contextResponseSchema.parse({
              available: true,
              source: 'github_comparison',
              file: finding.file,
              line: finding.line,
              content: context.content.slice(0, 16_384),
              start_line: context.startLine,
              end_line: context.endLine,
              unavailable_reason: null,
            }),
            200,
          );
        }
      } catch {
        /* context is best effort and must not hide the finding */
      }
    }
    return c.json(
      contextResponseSchema.parse({
        available: false,
        source: 'unavailable',
        file: finding.file,
        line: finding.line,
        content: null,
        start_line: null,
        end_line: null,
        unavailable_reason: 'GITHUB_CONTEXT_UNAVAILABLE',
      }),
      200,
    );
  });
}

function writeEvaluation(
  c: Context,
  database: JobDatabase,
  id: number,
  targetType: 'review' | 'finding',
  request: ReviewEvaluationWriteRequest | FindingEvaluationWriteRequest,
  fingerprint?: string,
) {
  if (database.getReviewJob(id) === undefined) {
    return apiError(c, 404, 'review not found', 'NOT_FOUND');
  }
  try {
    const revision = database.setEvaluation({
      jobId: id,
      targetType,
      ...(fingerprint === undefined ? {} : { findingFingerprint: fingerprint }),
      verdict: request.verdict,
      ...(request.rationale === undefined ? {} : { rationale: request.rationale }),
      expectedPreviousId: request.expected_previous_id,
    });
    return json(
      c,
      evaluationWriteResponseSchema.parse({
        revision: mapEvaluation(revision),
        current: mapEvaluation(database.getCurrentEvaluation(id, targetType, fingerprint)),
      }),
    );
  } catch (error) {
    return evaluationError(c, error);
  }
}

function withdrawEvaluation(
  c: Context,
  database: JobDatabase,
  id: number,
  targetType: 'review' | 'finding',
  request: DeleteEvaluationRequest,
  fingerprint?: string,
) {
  if (database.getReviewJob(id) === undefined) {
    return apiError(c, 404, 'review not found', 'NOT_FOUND');
  }
  try {
    const revision = database.withdrawEvaluation({
      jobId: id,
      targetType,
      ...(fingerprint === undefined ? {} : { findingFingerprint: fingerprint }),
      expectedPreviousId: request.expected_previous_id,
    });
    return json(
      c,
      evaluationWriteResponseSchema.parse({ revision: mapEvaluation(revision), current: null }),
    );
  } catch (error) {
    return evaluationError(c, error);
  }
}
