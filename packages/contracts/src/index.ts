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

export const reviewExecutionQuerySchema = z.object({
  after: z.coerce.number().int().nonnegative().default(0),
});

export const reviewExecutionStageSchema = z.enum([
  'queued',
  'checking_out',
  'sandbox_creating',
  'reviewing',
  'validating',
  'publishing',
  'done',
  'failed',
  'timed_out',
  'cancelled',
  'superseded',
  'unknown',
]);

export const reviewExecutionEventTypeSchema = z.enum([
  'attempt_started',
  'sandbox_environment',
  'process_heartbeat',
  'thread_started',
  'turn_started',
  'command_started',
  'command_completed',
  'agent_message',
  'file_change',
  'tool_activity',
  'turn_completed',
  'turn_failed',
  'trace_notice',
]);

export const reviewExecutionEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  attempt: z.number().int().positive(),
  observed_at: z.string().datetime({ offset: true }),
  type: reviewExecutionEventTypeSchema,
  item_id: z.string().nullable(),
  command: z.string().nullable(),
  status: z.string().nullable(),
  exit_code: z.number().int().nullable(),
  duration_ms: z.number().int().nonnegative().nullable(),
  output: z.string().nullable(),
  output_truncated: z.boolean(),
  message: z.string().nullable(),
  notice_code: z.string().nullable(),
});

export const reviewExecutionCurrentCommandSchema = z.object({
  item_id: z.string(),
  command: z.string(),
  started_at: z.string().datetime({ offset: true }),
});

export const reviewExecutionSnapshotSchema = z.object({
  review_id: z.number().int().positive(),
  available: z.boolean(),
  unavailable_reason: z.string().nullable(),
  attempt: z.number().int().nonnegative(),
  status: reviewStatusSchema,
  stage: reviewExecutionStageSchema,
  started_at: z.string().datetime({ offset: true }).nullable(),
  process_heartbeat_at: z.string().datetime({ offset: true }).nullable(),
  last_activity_at: z.string().datetime({ offset: true }).nullable(),
  last_sequence: z.number().int().nonnegative(),
  trace_truncated: z.boolean(),
  current_command: reviewExecutionCurrentCommandSchema.nullable(),
  events: z.array(reviewExecutionEventSchema),
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

export const developmentPhaseSchema = z.enum([
  'intake',
  'preparing',
  'planning',
  'awaiting_plan_approval',
  'implementing',
  'verifying',
  'awaiting_publication_approval',
  'publishing',
  'reviewing',
  'awaiting_merge',
  'waiting_for_input',
  'completed',
  'failed',
  'cancelled',
]);

export const developmentRunIdParamsSchema = z.object({
  runId: z.coerce.number().int().positive(),
});

export const developmentRunCreateSchema = z.object({
  goal: z.string().trim().min(1).max(20_000),
  repository: z
    .string()
    .trim()
    .regex(/^[^/\s]+\/[^/\s]+$/),
  external_source: z
    .object({
      provider: z.string().trim().min(1).max(80),
      id: z.string().trim().min(1).max(255),
      key: z.string().trim().min(1).max(255).nullable(),
      url: z.url().nullable(),
    })
    .optional(),
});

export const developmentRunSummarySchema = z.object({
  id: z.number().int().positive(),
  workflow: z.literal('development-v1'),
  repository: z.string(),
  phase: developmentPhaseSchema,
  prior_phase: developmentPhaseSchema.nullable(),
  generation: z.number().int().positive(),
  revision: z.number().int().positive(),
  goal: z.string(),
  candidate_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  operator_action: z.enum(['answer', 'approve_plan', 'approve_publication']).nullable(),
  last_activity_at: isoDate,
  created_at: isoDate,
  updated_at: isoDate,
});

export const developmentEventTrustSchema = z.enum([
  'system_observed',
  'harness_observed',
  'agent_claimed',
  'human_decided',
]);

export const developmentEventSchema = z.object({
  schema_version: z.literal(1),
  sequence: z.number().int().positive(),
  generation: z.number().int().positive(),
  observed_at: isoDate,
  type: z.string().min(1).max(120),
  source: z.enum(['leverframe', 'codex', 'sandbox', 'github', 'ticket', 'human']),
  trust: developmentEventTrustSchema,
  payload: z.record(z.string(), z.unknown()),
});

export const developmentInterruptSchema = z.object({
  id: z.number().int().positive(),
  kind: z.enum(['clarification', 'plan_approval', 'publication_approval']),
  status: z.enum(['open', 'answered', 'approved', 'rejected', 'cancelled', 'superseded']),
  prompt: z.string(),
  questions: z
    .array(
      z.object({
        id: z.string().min(1).max(120),
        header: z.string().min(1).max(120),
        question: z.string().min(1).max(2000),
        is_other: z.boolean(),
        options: z
          .array(
            z.object({
              label: z.string().min(1).max(200),
              description: z.string().max(1000),
            }),
          )
          .nullable(),
      }),
    )
    .max(3)
    .nullable(),
  candidate_hash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  publication_kind: z.enum(['push_and_pr', 'push_existing']).nullable(),
  lock_version: z.number().int().positive(),
  requested_at: isoDate,
  resolved_at: isoDate.nullable(),
});

export const developmentClarificationAnswerSchema = z.object({
  interrupt_id: z.number().int().positive(),
  expected_lock_version: z.number().int().positive(),
  answers: z
    .record(z.string().min(1).max(120), z.array(z.string().trim().min(1).max(4000)).min(1).max(5))
    .refine((answers) => JSON.stringify(answers).length <= 20_000, 'answers are too large'),
});

export const developmentEvidenceSchema = z.object({
  id: z.number().int().positive(),
  criterion: z.string(),
  method: z.enum(['command', 'browser', 'inspection', 'external_observation']),
  observation: z.string(),
  trust: developmentEventTrustSchema,
  verdict: z.enum(['passed', 'failed', 'unresolved']),
  candidate_hash: z.string().regex(/^[0-9a-f]{64}$/),
  created_at: isoDate,
});

export const developmentPlanApprovalSchema = z.object({
  interrupt_id: z.number().int().positive(),
  expected_lock_version: z.number().int().positive(),
  approve: z.boolean(),
  response: z.string().trim().max(20_000).optional(),
});

export const developmentPublicationApprovalSchema = z.object({
  interrupt_id: z.number().int().positive(),
  expected_lock_version: z.number().int().positive(),
  candidate_hash: z.string().regex(/^[0-9a-f]{64}$/),
  approve: z.boolean(),
  response: z.string().trim().max(20_000).optional(),
});

export const developmentRunDetailSchema = z.object({
  run: developmentRunSummarySchema,
  events: z.array(developmentEventSchema),
  interrupt: developmentInterruptSchema.nullable(),
  evidence: z.array(developmentEvidenceSchema),
});

export const developmentRunListSchema = z.object({
  items: z.array(developmentRunSummarySchema),
});

export type StatusResponse = z.infer<typeof statusResponseSchema>;
export type DependencyStatus = z.infer<typeof dependencyStatusSchema>;
export type ReviewListItem = z.infer<typeof reviewListItemSchema>;
export type ReviewListResponse = z.infer<typeof reviewListResponseSchema>;
export type ReviewDetail = z.infer<typeof reviewDetailSchema>;
export type ReviewExecutionEvent = z.infer<typeof reviewExecutionEventSchema>;
export type ReviewExecutionSnapshot = z.infer<typeof reviewExecutionSnapshotSchema>;
export type ReviewEvaluation = z.infer<typeof reviewEvaluationSchema>;
export type EvaluationHistory = z.infer<typeof evaluationHistorySchema>;
export type EvaluationsResponse = z.infer<typeof evaluationsResponseSchema>;
export type ReviewEvaluationWriteRequest = z.infer<typeof reviewEvaluationWriteRequestSchema>;
export type FindingEvaluationWriteRequest = z.infer<typeof findingEvaluationWriteRequestSchema>;
export type DeleteEvaluationRequest = z.infer<typeof deleteEvaluationRequestSchema>;
export type ContextResponse = z.infer<typeof contextResponseSchema>;
export type DevelopmentPhase = z.infer<typeof developmentPhaseSchema>;
export type DevelopmentRunCreate = z.infer<typeof developmentRunCreateSchema>;
export type DevelopmentRunSummary = z.infer<typeof developmentRunSummarySchema>;
export type DevelopmentEvent = z.infer<typeof developmentEventSchema>;
export type DevelopmentInterrupt = z.infer<typeof developmentInterruptSchema>;

export type DevelopmentClarificationAnswer = z.infer<typeof developmentClarificationAnswerSchema>;

export type DevelopmentEvidence = z.infer<typeof developmentEvidenceSchema>;
export type DevelopmentPlanApproval = z.infer<typeof developmentPlanApprovalSchema>;
export type DevelopmentPublicationApproval = z.infer<typeof developmentPublicationApprovalSchema>;
export type DevelopmentRunDetail = z.infer<typeof developmentRunDetailSchema>;
