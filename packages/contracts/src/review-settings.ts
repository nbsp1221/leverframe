import { z } from 'zod';

export const reviewReasoningEffortSchema = z.enum([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);

// Keep the picker scoped to the Codex review runner, not connected user sessions.
export const reviewModels = [
  { id: 'gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6 Sol' },
].map((model) => ({
  ...model,
  reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] as const,
}));

export const reviewModelSettingsSchema = z.object({
  model: z.string().min(1).max(200),
  reasoningEffort: reviewReasoningEffortSchema,
});

export const reviewSettingsWriteSchema = reviewModelSettingsSchema
  .strict()
  .refine(
    (settings) =>
      reviewModels.some(
        (model) =>
          model.id === settings.model &&
          model.reasoningEfforts.some((effort) => effort === settings.reasoningEffort),
      ),
    { message: 'Unsupported review model or reasoning effort.' },
  );

export const reviewSettingsResponseSchema = z.object({
  current: reviewModelSettingsSchema,
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      reasoningEfforts: z.array(reviewReasoningEffortSchema),
    }),
  ),
});

export type ReviewModelSettings = z.infer<typeof reviewModelSettingsSchema>;
export type ReviewSettingsResponse = z.infer<typeof reviewSettingsResponseSchema>;
