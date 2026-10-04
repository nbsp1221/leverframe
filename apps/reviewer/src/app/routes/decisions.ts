import { timingSafeEqual } from 'node:crypto';
import { type OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { errorResponseSchema } from '@repo/contracts';
import {
  type Decision,
  decisionAnswerSchema,
  decisionCreateSchema,
  decisionListSchema,
  decisionSchema,
} from '@repo/contracts/decisions';
import { bodyLimit } from 'hono/body-limit';
import {
  DecisionConflict,
  DecisionMissing,
  type DecisionService,
} from '../../decisions/service.js';

const params = z.object({ id: z.string().min(1).max(100) });
const error = z.object({ error: z.string() });

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  404: { description: 'Decision not found', content: json(error) },
  409: { description: 'Decision changed; read it again', content: json(error) },
  422: { description: 'Invalid request', content: json(errorResponseSchema) },
  503: { description: 'Decision service is not configured', content: json(error) },
};

export interface DecisionRegistration {
  token: string;
  resolve: (threadId: string) => Promise<Decision['context']>;
}

export function registerDecisionRoutes(
  app: OpenAPIHono,
  service?: DecisionService,
  registration?: DecisionRegistration,
): void {
  app.openAPIRegistry.registerComponent('securitySchemes', 'DecisionAgentToken', {
    type: 'http',
    scheme: 'bearer',
    description: 'Token for creating requests only; does not authorize answering for the user.',
  });
  app.use('/api/v1/decisions', bodyLimit({ maxSize: 65536 }));
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/decisions',
      operationId: 'createDecision',
      security: [{ DecisionAgentToken: [] }],
      tags: ['Decisions'],
      request: {
        headers: z.object({ authorization: z.string().optional() }),
        body: { required: true, content: json(decisionCreateSchema) },
      },
      responses: {
        200: {
          description:
            'Durably registered request (same key and payload return the existing request)',
          content: json(decisionSchema),
        },
        401: { description: 'Agent registration token required', content: json(error) },
        ...errors,
      },
    }),
    async (c) => {
      if (!service || !registration) {
        return c.json({ error: 'not_configured' }, 503);
      }
      const actual = Buffer.from(c.req.header('authorization') ?? '');
      const expected = Buffer.from(`Bearer ${registration.token}`);
      if (
        !registration.token ||
        actual.length !== expected.length ||
        !timingSafeEqual(actual, expected)
      ) {
        return c.json({ error: 'unauthorized' }, 401);
      }
      try {
        return c.json(await service.create(c.req.valid('json'), registration.resolve), 200);
      } catch (cause) {
        if (cause instanceof DecisionConflict) {
          return c.json({ error: cause.message }, 409);
        }
        return c.json({ error: 'agent_unavailable' }, 503);
      }
    },
  );
  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/decisions/{id}/snooze',
      operationId: 'snoozeDecision',
      tags: ['Decisions'],
      request: {
        params,
        body: {
          required: true,
          content: json(
            z.object({ expectedRevision: z.number().int().nonnegative(), deferred: z.boolean() }),
          ),
        },
      },
      responses: {
        200: {
          description: 'Visibility deferred; no execution authorized',
          content: json(decisionSchema),
        },
        ...errors,
      },
    }),
    (c) => {
      if (!service) {
        return c.json({ error: 'not_configured' }, 503);
      }
      try {
        const input = c.req.valid('json');
        return c.json(
          service.snooze(c.req.valid('param').id, input.expectedRevision, input.deferred),
          200,
        );
      } catch (cause) {
        if (cause instanceof DecisionMissing) {
          return c.json({ error: 'not_found' }, 404);
        }
        if (cause instanceof DecisionConflict) {
          return c.json({ error: cause.message }, 409);
        }
        throw cause;
      }
    },
  );
  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/decisions',
      operationId: 'listDecisions',
      tags: ['Decisions'],
      responses: {
        200: { description: 'Decision requests', content: json(decisionListSchema) },
        503: errors[503],
      },
    }),
    (c) =>
      service ? c.json({ items: service.list() }, 200) : c.json({ error: 'not_configured' }, 503),
  );

  app.openapi(
    createRoute({
      method: 'get',
      path: '/api/v1/decisions/{id}',
      operationId: 'getDecision',
      tags: ['Decisions'],
      request: { params },
      responses: {
        200: { description: 'Decision request', content: json(decisionSchema) },
        404: errors[404],
        422: errors[422],
        503: errors[503],
      },
    }),
    (c) => {
      if (!service) {
        return c.json({ error: 'not_configured' }, 503);
      }
      try {
        return c.json(service.get(c.req.valid('param').id), 200);
      } catch (cause) {
        if (cause instanceof DecisionMissing) {
          return c.json({ error: 'not_found' }, 404);
        }
        throw cause;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/decisions/{id}/answers',
      operationId: 'answerDecision',
      tags: ['Decisions'],
      request: {
        params,
        body: { required: true, content: json(decisionAnswerSchema) },
      },
      responses: {
        200: {
          description: 'Durably stored answer; not yet applied',
          content: json(decisionSchema),
        },
        ...errors,
      },
    }),
    (c) => {
      if (!service) {
        return c.json({ error: 'not_configured' }, 503);
      }
      try {
        return c.json(service.answer(c.req.valid('param').id, c.req.valid('json')), 200);
      } catch (cause) {
        if (cause instanceof DecisionMissing) {
          return c.json({ error: 'not_found' }, 404);
        }
        if (cause instanceof DecisionConflict) {
          return c.json({ error: cause.message }, 409);
        }
        throw cause;
      }
    },
  );

  app.openapi(
    createRoute({
      method: 'post',
      path: '/api/v1/decisions/{id}/retry',
      operationId: 'retryDecision',
      tags: ['Decisions'],
      request: {
        params,
        body: {
          required: true,
          content: json(z.object({ expectedRevision: z.number().int().nonnegative() })),
        },
      },
      responses: {
        200: {
          description: 'Retry queued with original delivery identity',
          content: json(decisionSchema),
        },
        ...errors,
      },
    }),
    (c) => {
      if (!service) {
        return c.json({ error: 'not_configured' }, 503);
      }
      try {
        return c.json(
          service.retry(c.req.valid('param').id, c.req.valid('json').expectedRevision),
          200,
        );
      } catch (cause) {
        if (cause instanceof DecisionMissing) {
          return c.json({ error: 'not_found' }, 404);
        }
        if (cause instanceof DecisionConflict) {
          return c.json({ error: cause.message }, 409);
        }
        throw cause;
      }
    },
  );
}
