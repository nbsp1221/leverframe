import { z } from 'zod';

/** Public, versioned wire contracts. Persistence rows and Hono types must not leak here. */
export const reviewStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'superseded',
  'queued',
  'cancelled',
  'unknown',
]);
export const dependencyStatusSchema = z.enum(['healthy', 'degraded', 'unavailable', 'unknown']);
export const reviewVerdictSchema = z.enum(['useful', 'mixed', 'not_useful', 'unable_to_assess']);
export const findingVerdictSchema = z.enum([
  'valid',
  'partially_valid',
  'false_positive',
  'unable_to_verify',
]);

const reviewStatusFilterSchema = z.enum([
  'running',
  'completed',
  'failed',
  'superseded',
  'queued',
  'cancelled',
]);
const reviewStatusFilterListSchema = z
  .string()
  .regex(
    /^\s*(?:running|completed|failed|superseded|queued|cancelled)(?:\s*,\s*(?:running|completed|failed|superseded|queued|cancelled))*\s*$/,
  );
const canonicalReviewStatusFilterEntrySchema = z.union([
  reviewStatusFilterSchema,
  reviewStatusFilterListSchema,
]);
const reviewStatusFilterEntrySchema = z.preprocess(
  (value) => (typeof value === 'string' ? value.toLowerCase() : value),
  canonicalReviewStatusFilterEntrySchema,
);

export const reviewListQuerySchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  page_size: z.coerce
    .number()
    .pipe(z.literal(20))
    .default(20)
    .meta({ type: 'number', const: 20, default: 20 }),
  sort: z.enum(['created', 'completed']).default('created'),
  query: z.string().trim().optional(),
  evaluation: z.enum(['evaluated', 'needs_evaluation']).optional(),
  status: z
    .union([reviewStatusFilterEntrySchema, z.array(reviewStatusFilterEntrySchema)])
    .optional(),
});

export const reviewIdParamsSchema = z.object({
  reviewId: z.coerce.number().int().positive(),
});

export const findingParamsSchema = reviewIdParamsSchema.extend({
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
});

const isoDate = z.string().datetime({ offset: true });
const nullableString = z.string().nullable();

export const dependencyObservationSchema = z.object({
  status: dependencyStatusSchema,
  last_observed_at: isoDate.nullable(),
  detail: z.string().nullable(),
});

export const statusResponseSchema = z.object({
  overall: dependencyStatusSchema,
  observed_at: isoDate,
  api: dependencyObservationSchema,
  database: dependencyObservationSchema,
  worker: dependencyObservationSchema,
  sandbox: dependencyObservationSchema,
  github: dependencyObservationSchema,
  active_jobs: z.number().int().nonnegative(),
  active_stages: z.record(z.string(), z.number().int().nonnegative()),
});

export const reviewListItemSchema = z.object({
  id: z.number().int().nonnegative(),
  repository: z.string(),
  pull_request_number: z.number().int().positive(),
  pull_request_title: nullableString,
  head_sha: z.string(),
  base_sha: nullableString,
  status: reviewStatusSchema,
  model: nullableString,
  reasoning: nullableString,
  findings_count: z.number().int().nonnegative().nullable(),
  highest_severity: z.enum(['critical', 'high', 'medium', 'low']).nullable(),
  review_evaluation: reviewVerdictSchema.nullable(),
  evaluated_findings: z.number().int().nonnegative(),
  total_findings: z.number().int().nonnegative(),
  created_at: isoDate,
  started_at: isoDate.nullable(),
  completed_at: isoDate.nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
});

export const reviewListResponseSchema = z.object({
  items: z.array(reviewListItemSchema),
  page: z.number().int().positive(),
  page_size: z.literal(20),
  total_items: z.number().int().nonnegative(),
  total_pages: z.number().int().nonnegative(),
});

export const reviewFindingSchema = z.object({
  fingerprint: z.string().regex(/^[0-9a-f]{16}$/),
  severity: z.enum(['critical', 'high', 'medium', 'low']),
  confidence: z.enum(['high', 'medium', 'low']),
  title: z.string(),
  explanation: z.string(),
  suggested_action: z.string(),
  evidence: z.string(),
  file: z.string(),
  line: z.number().int().positive(),
  state: z.enum(['open', 'fixed', 'still_present']).nullable(),
  thread_resolution: z
    .object({
      state: z.enum(['open', 'pending', 'resolved', 'failed']),
      resolved_at: isoDate.nullable(),
      resolved_head_sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
      last_error: z.string().nullable(),
    })
    .nullable(),
  evaluation: findingVerdictSchema.nullable(),
});

export const reviewEvaluationSchema = z.object({
  id: z.number().int().positive(),
  target_type: z.enum(['review', 'finding']),
  finding_fingerprint: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .nullable(),
  verdict: z.union([reviewVerdictSchema, findingVerdictSchema]).nullable(),
  rationale: z.string().nullable(),
  source: z.literal('manual'),
  action: z.enum(['set', 'withdraw']),
  supersedes_id: z.number().int().positive().nullable(),
  created_at: isoDate,
});

export const evaluationHistorySchema = z.object({
  current: reviewEvaluationSchema.nullable(),
  history: z.array(reviewEvaluationSchema),
  truncated: z.boolean(),
});
export const evaluationsResponseSchema = z.object({
  review: evaluationHistorySchema,
  findings: z.record(z.string(), evaluationHistorySchema),
});
export const evaluationWriteResponseSchema = z.object({
  revision: reviewEvaluationSchema,
  current: reviewEvaluationSchema.nullable(),
});

export const reviewDetailSchema = z.object({
  id: z.number().int().nonnegative(),
  repository: z.string(),
  pull_request_number: z.number().int().positive(),
  pull_request_title: nullableString,
  head_sha: z.string(),
  base_sha: nullableString,
  installation_id: z.number().int().positive().nullable(),
  action: z.string().nullable(),
  status: reviewStatusSchema,
  attempt: z.number().int().nonnegative().nullable(),
  model: nullableString,
  reasoning: nullableString,
  prompt_version: nullableString,
  prompt_hash: nullableString,
  schema_version: nullableString,
  schema_hash: nullableString,
  created_at: isoDate,
  review_started_at: isoDate.nullable(),
  review_completed_at: isoDate.nullable(),
  publication_started_at: isoDate.nullable(),
  published_at: isoDate.nullable(),
  published_review_id: z.number().int().positive().nullable(),
  error_code: nullableString,
  error_excerpt: nullableString,
  superseded_by_job_id: z.number().int().positive().nullable(),
  artifact: z.object({
    available: z.boolean(),
    content_hash: z.string().nullable(),
    unavailable_reason: z.string().nullable(),
    summary: z.string().nullable(),
    findings: z.array(reviewFindingSchema),
    coverage: z
      .object({
        changed_files: z.array(z.string()),
        reviewed_files: z.array(z.string()),
        omitted_files: z.array(z.string()),
        complete: z.boolean(),
      })
      .nullable(),
    limitations: z.array(z.string()),
    tests_run: z.array(
      z.object({
        command: z.string(),
        status: z.enum(['passed', 'failed', 'not_run']),
        evidence: z.string(),
      }),
    ),
  }),
  review_evaluation: reviewEvaluationSchema.nullable(),
});

const evaluationWriteRequestSchema = z.object({
  verdict: z.union([reviewVerdictSchema, findingVerdictSchema]),
  rationale: z.string().trim().max(4000).optional(),
  expected_previous_id: z.number().int().positive().nullable(),
});
export const reviewEvaluationWriteRequestSchema = evaluationWriteRequestSchema.extend({
  verdict: reviewVerdictSchema,
});
export const findingEvaluationWriteRequestSchema = evaluationWriteRequestSchema.extend({
  verdict: findingVerdictSchema,
});
export const deleteEvaluationRequestSchema = z.object({
  expected_previous_id: z.number().int().positive().nullable(),
});

export const contextResponseSchema = z.object({
  available: z.boolean(),
  source: z.enum(['stored_evidence', 'github_comparison', 'unavailable']),
  file: z.string(),
  line: z.number().int().positive(),
  content: z.string().nullable(),
  start_line: z.number().int().positive().nullable(),
  end_line: z.number().int().positive().nullable(),
  unavailable_reason: z.string().nullable(),
});

export const errorResponseSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  details: z.unknown().optional(),
});

export type StatusResponse = z.infer<typeof statusResponseSchema>;
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type ReviewListItem = z.infer<typeof reviewListItemSchema>;
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;
export type ReviewEvaluation = z.infer<typeof reviewEvaluationSchema>;
export type EvaluationHistory = z.infer<typeof evaluationHistorySchema>;
export type EvaluationsResponse = z.infer<typeof evaluationsResponseSchema>;
export type ReviewEvaluationWriteRequest = z.infer<typeof reviewEvaluationWriteRequestSchema>;
export type FindingEvaluationWriteRequest = z.infer<typeof findingEvaluationWriteRequestSchema>;
export type DeleteEvaluationRequest = z.infer<typeof deleteEvaluationRequestSchema>;
export type ContextResponse = z.infer<typeof contextResponseSchema>;
