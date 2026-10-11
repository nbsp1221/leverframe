import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { errorResponseSchema } from '@repo/contracts';
import {
  type ReviewModelSettings,
  reviewModels,
  reviewSettingsResponseSchema,
  reviewSettingsWriteSchema,
} from '@repo/contracts/review-settings';
import type { ReviewSettingsRepository } from '../../storage/review-settings-repository.js';
import { apiError, json } from '../server-common.js';

const response = {
  description: 'Effective review settings and the supported review runner model catalog.',
  content: { 'application/json': { schema: reviewSettingsResponseSchema } },
};

export function registerReviewSettingsRoutes(
  app: OpenAPIHono,
  repository: ReviewSettingsRepository,
  defaults: ReviewModelSettings,
) {
  const current = () =>
    reviewSettingsResponseSchema.parse({ current: repository.get(defaults), models: reviewModels });

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/settings/reviews',
      operationId: 'getReviewModelSettings',
      tags: ['Settings'],
      summary: 'Get automatic code review model settings',
      responses: { 200: response },
    }),
    (c) => json(c, current(), 200),
  );
  app.openapi(
    createRoute({
      method: 'put',
      path: '/api/v1/settings/reviews',
      operationId: 'setReviewModelSettings',
      tags: ['Settings'],
      summary: 'Save the model and reasoning effort for subsequent review executions',
      description:
        'Private operator endpoint. Persisted settings override startup environment defaults for code reviews only. Already started executions retain their settings; queued executions use the settings when they start. Model catalog support does not verify account entitlement or model quality.',
      request: {
        body: {
          required: true,
          content: { 'application/json': { schema: reviewSettingsWriteSchema } },
        },
      },
      responses: {
        200: response,
        403: {
          description: 'Cross-origin browser writes are rejected.',
          content: { 'application/json': { schema: errorResponseSchema } },
        },
        422: {
          description: 'Unsupported model, reasoning effort, or malformed request.',
          content: { 'application/json': { schema: errorResponseSchema } },
        },
      },
    }),
    (c) => {
      const origin = c.req.header('origin');
      if (origin && origin !== new URL(c.req.url).origin) {
        return apiError(c, 403, 'origin_rejected');
      }
      repository.save(c.req.valid('json'));
      return json(c, current(), 200);
    },
  );
}
