import { z } from 'zod';

export const decisionStatusSchema = z.enum([
  'awaiting_answer',
  'queued',
  'delivered',
  'investigating',
  'applied',
  'delivery_failed',
  'superseded',
  'discarded',
]);
export const decisionAnswerSchema = z
  .object({
    id: z.string().min(1).max(100),
    expectedRevision: z.number().int().nonnegative(),
    intent: z.enum(['decide', 'research']),
    optionId: z.string().max(100).optional(),
    text: z.string().trim().max(4000),
  })
  .refine(
    (value) => value.text.length > 0 || (value.intent === 'decide' && Boolean(value.optionId)),
    {
      message: 'An answer or an option is required',
    },
  );
export const decisionSchema = z.object({
  id: z.string(),
  revision: z.number().int().nonnegative(),
  project: z.string(),
  title: z.string(),
  goal: z.string(),
  question: z.string(),
  why: z.string(),
  mode: z.enum(['blocking', 'nonblocking']),
  waitingFor: z.string(),
  continuing: z.string(),
  assumption: z.string().nullable(),
  constraints: z.array(z.string()).default([]),
  snoozedUntil: z.string().datetime().nullable().default(null),
  context: z.object({
    connectionId: z.string().min(1).optional(),
    agentId: z.string(),
    threadId: z.string(),
    taskId: z.string(),
    taskRevision: z.string(),
  }),
  facts: z.array(z.object({ label: z.string(), detail: z.string() })),
  options: z.array(
    z.object({ id: z.string(), label: z.string(), effect: z.string(), recommended: z.boolean() }),
  ),
  recommendation: z.string(),
  recommendationUnavailableReason: z.string().trim().min(1).max(4000).optional(),
  status: decisionStatusSchema,
  deliveryIssue: z.enum(['offline', 'busy', 'unsupported', 'unconfirmed']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  answers: z.array(
    z.object({
      id: z.string(),
      intent: z.enum(['decide', 'research']),
      optionId: z.string().optional(),
      text: z.string(),
      at: z.string(),
      expectedRevision: z.number().int(),
    }),
  ),
  events: z.array(
    z.object({
      id: z.string(),
      kind: z.enum([
        'opened',
        'answered',
        'delivered',
        'investigating',
        'needs_input',
        'applied',
        'delivery_failed',
        'retry',
        'superseded',
        'discarded',
        'snoozed',
        'woken',
        'recommendation_updated',
      ]),
      at: z.string(),
      text: z.string(),
    }),
  ),
});
export const decisionListSchema = z.object({ items: z.array(decisionSchema) });

/** Agent input only. Lifecycle state and execution context are assigned by the server. */
export const decisionCreateSchema = decisionSchema
  .pick({
    project: true,
    title: true,
    goal: true,
    question: true,
    why: true,
    mode: true,
    waitingFor: true,
    continuing: true,
    assumption: true,
    constraints: true,
    facts: true,
    options: true,
    recommendation: true,
    recommendationUnavailableReason: true,
  })
  .extend({
    key: z.string().min(1).max(100),
    threadId: z.string().uuid().optional(),
    source: z
      .object({ connectionId: z.string().min(1).max(100), sessionId: z.string().min(1).max(200) })
      .strict()
      .optional(),
    project: z.string().trim().min(1).max(100),
    title: z.string().trim().min(1).max(200),
    question: z.string().trim().min(1).max(4000),
    why: z.string().trim().min(1).max(4000),
    // Restrict new inputs without making older persisted questions unreadable.
    options: decisionSchema.shape.options.element
      .extend({ id: z.string().min(1).max(100) })
      .array(),
  })
  .strict()
  .refine((value) => Boolean(value.threadId) !== Boolean(value.source), {
    message: 'Provide either source or the legacy threadId',
  })
  .superRefine((value, context) => {
    const count = value.options.filter((option) => option.recommended).length;
    if (count === 1 && value.recommendation.trim() && !value.recommendationUnavailableReason) {
      return;
    }
    if (count === 0 && !value.recommendation.trim() && value.recommendationUnavailableReason) {
      return;
    }
    context.addIssue({
      code: 'custom',
      path: ['recommendation'],
      message:
        'Mark exactly one option recommended and give its reason, or explicitly provide recommendationUnavailableReason with no recommendation. Never leave the recommendation decision implicit.',
    });
  })
  .refine(
    (value) => new Set(value.options.map((option) => option.id)).size === value.options.length,
    {
      message: 'Option identifiers must be unique',
    },
  )
  .refine(
    (value) =>
      value.mode !== 'nonblocking' || Boolean(value.assumption?.trim() && value.continuing.trim()),
    {
      message: 'Nonblocking requests need an authorized assumption and independent work',
    },
  );

export type DecisionCreate = z.infer<typeof decisionCreateSchema>;

export type Decision = z.infer<typeof decisionSchema>;
export type DecisionAnswer = z.infer<typeof decisionAnswerSchema>;
export type DecisionStatus = z.infer<typeof decisionStatusSchema>;
