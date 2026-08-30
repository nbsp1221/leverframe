import type { ZodType } from 'zod';
import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  developmentClarificationAnswerSchema,
  developmentEventSchema,
  developmentEvidenceSchema,
  developmentInterruptSchema,
  developmentPlanApprovalSchema,
  developmentPublicationApprovalSchema,
  developmentRepositoryListSchema,
  developmentRepositoryQuerySchema,
  developmentRunCreateSchema,
  developmentRunDetailSchema,
  developmentRunIdParamsSchema,
  developmentRunListSchema,
  developmentRunSummarySchema,
  developmentTicketImportSchema,
  developmentTicketListSchema,
  errorResponseSchema,
} from '@repo/contracts';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { JobDatabase } from '../../jobs/database.js';
import type { DevelopmentRun } from '../../storage/development-repository.js';
import type { ServerHooks } from '../server-common.js';
import { DevelopmentConflictError } from '../../storage/development-repository.js';
import { apiError, json } from '../server-common.js';

const jsonResponse = (schema: ZodType, description: string) =>
  ({
    description,
    content: { 'application/json': { schema } },
  }) as const;

const listRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/runs',
  operationId: 'listDevelopmentRuns',
  tags: ['Development'],
  summary: 'List Leverframe-owned development runs',
  responses: { 200: jsonResponse(developmentRunListSchema, 'Development runs.') },
});

const repositoryListRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/repositories',
  operationId: 'listDevelopmentRepositories',
  tags: ['Development'],
  summary: 'List repositories explicitly accessible to the Leverframe GitHub App',
  request: { query: developmentRepositoryQuerySchema },
  responses: {
    200: jsonResponse(developmentRepositoryListSchema, 'Accessible repositories.'),
    422: jsonResponse(errorResponseSchema, 'The catalog query is invalid.'),
    503: jsonResponse(errorResponseSchema, 'The GitHub App repository catalog is unavailable.'),
  },
});

const ticketListRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/tickets',
  operationId: 'listDevelopmentTickets',
  tags: ['Development'],
  summary: 'List optional external tickets available for import',
  responses: {
    200: jsonResponse(developmentTicketListSchema, 'Importable tickets.'),
    503: jsonResponse(errorResponseSchema, 'The optional ticket adapter is unavailable.'),
  },
});

const ticketImportRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/tickets/{ticketId}/import',
  operationId: 'importDevelopmentTicket',
  tags: ['Development'],
  summary: 'Read one external ticket as non-authoritative development input',
  request: { params: z.object({ ticketId: z.string().min(1).max(255) }) },
  responses: {
    200: jsonResponse(developmentTicketImportSchema, 'Ticket import snapshot.'),
    422: jsonResponse(errorResponseSchema, 'The ticket identifier is invalid.'),
    503: jsonResponse(errorResponseSchema, 'The optional ticket adapter is unavailable.'),
  },
});

const createRunRoute = createRoute({
  method: 'post',
  path: '/api/v1/development/runs',
  operationId: 'createDevelopmentRun',
  tags: ['Development'],
  summary: 'Create a web-native development run',
  request: {
    body: {
      required: true,
      content: { 'application/json': { schema: developmentRunCreateSchema } },
    },
  },
  responses: {
    201: jsonResponse(developmentRunSummarySchema, 'The accepted development run.'),
    409: jsonResponse(
      errorResponseSchema,
      'Development is unavailable or the repository is not configured.',
    ),
    503: jsonResponse(errorResponseSchema, 'GitHub App access could not be verified.'),
    422: jsonResponse(errorResponseSchema, 'The request is invalid.'),
  },
});

const detailRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/runs/{runId}',
  operationId: 'getDevelopmentRun',
  tags: ['Development'],
  summary: 'Get bounded development state, conversation, evidence, and action',
  request: { params: developmentRunIdParamsSchema },
  responses: {
    200: jsonResponse(developmentRunDetailSchema, 'The development run.'),
    404: jsonResponse(errorResponseSchema, 'The run was not found.'),
    422: jsonResponse(errorResponseSchema, 'The run identifier is invalid.'),
  },
});

const approvePlanRoute = createRoute({
  method: 'post',
  path: '/api/v1/development/runs/{runId}/plan-approval',
  operationId: 'resolveDevelopmentPlanApproval',
  tags: ['Development'],
  summary: 'Approve or reject the current plan revision',
  request: {
    params: developmentRunIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: developmentPlanApprovalSchema } },
    },
  },
  responses: {
    202: jsonResponse(developmentRunSummarySchema, 'The decision was accepted.'),
    404: jsonResponse(errorResponseSchema, 'The run was not found.'),
    409: jsonResponse(errorResponseSchema, 'The decision or run revision is stale.'),
    422: jsonResponse(errorResponseSchema, 'The request is invalid.'),
  },
});

const answerClarificationRoute = createRoute({
  method: 'post',
  path: '/api/v1/development/runs/{runId}/clarification-answer',
  operationId: 'answerDevelopmentClarification',
  tags: ['Development'],
  summary: 'Answer the current material clarification request',
  request: {
    params: developmentRunIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: developmentClarificationAnswerSchema } },
    },
  },
  responses: {
    202: jsonResponse(developmentRunSummarySchema, 'The answers were accepted.'),
    404: jsonResponse(errorResponseSchema, 'The run was not found.'),
    409: jsonResponse(errorResponseSchema, 'The request or run revision is stale.'),
    422: jsonResponse(errorResponseSchema, 'The request is invalid.'),
  },
});

const streamRoute = createRoute({
  method: 'get',
  path: '/api/v1/development/runs/{runId}/events',
  operationId: 'streamDevelopmentRun',
  tags: ['Development'],
  summary: 'Follow resumable development run events',
  request: {
    params: developmentRunIdParamsSchema,
    query: z.object({ after: z.coerce.number().int().nonnegative().default(0) }),
  },
  responses: {
    200: {
      description: 'A resumable Server-Sent Events stream.',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    404: jsonResponse(errorResponseSchema, 'The run was not found.'),
    422: jsonResponse(errorResponseSchema, 'The run identifier or sequence is invalid.'),
  },
});

const approvePublicationRoute = createRoute({
  method: 'post',
  path: '/api/v1/development/runs/{runId}/publication-approval',
  operationId: 'resolveDevelopmentPublicationApproval',
  tags: ['Development'],
  summary: 'Approve or reject publication of the exact verified candidate',
  request: {
    params: developmentRunIdParamsSchema,
    body: {
      required: true,
      content: { 'application/json': { schema: developmentPublicationApprovalSchema } },
    },
  },
  responses: {
    202: jsonResponse(developmentRunSummarySchema, 'The candidate-bound decision was accepted.'),
    404: jsonResponse(errorResponseSchema, 'The run was not found.'),
    409: jsonResponse(errorResponseSchema, 'The decision, run, or candidate is stale.'),
    422: jsonResponse(errorResponseSchema, 'The request is invalid.'),
  },
});

export function registerDevelopmentRoutes(
  app: OpenAPIHono,
  database: JobDatabase,
  hooks: ServerHooks,
): void {
  app.openapi(ticketListRoute, async (c) => {
    if (hooks.listDevelopmentTickets === undefined) {
      return apiError(c, 503, 'ticket adapter is not configured', 'TICKET_ADAPTER_UNAVAILABLE');
    }
    try {
      return json(
        c,
        developmentTicketListSchema.parse({ items: await hooks.listDevelopmentTickets() }),
      );
    } catch (error) {
      console.error('failed to list development tickets', error);
      return apiError(c, 503, 'ticket adapter is unavailable', 'TICKET_ADAPTER_UNAVAILABLE');
    }
  });
  app.openapi(ticketImportRoute, async (c) => {
    if (hooks.importDevelopmentTicket === undefined) {
      return apiError(c, 503, 'ticket adapter is not configured', 'TICKET_ADAPTER_UNAVAILABLE');
    }
    try {
      return json(
        c,
        developmentTicketImportSchema.parse(
          await hooks.importDevelopmentTicket(c.req.valid('param').ticketId),
        ),
      );
    } catch (error) {
      console.error('failed to import development ticket', error);
      return apiError(c, 503, 'ticket adapter is unavailable', 'TICKET_ADAPTER_UNAVAILABLE');
    }
  });
  app.openapi(repositoryListRoute, async (c) => {
    if (hooks.listDevelopmentRepositories === undefined) {
      return apiError(c, 503, 'repository catalog is not configured', 'CATALOG_UNAVAILABLE');
    }
    try {
      const items = await hooks.listDevelopmentRepositories();
      const query = c.req.valid('query');
      const normalizedQuery = query.q.toLocaleLowerCase('en-US');
      const matching =
        normalizedQuery === ''
          ? items
          : items.filter((item) =>
              item.repository.toLocaleLowerCase('en-US').includes(normalizedQuery),
            );
      const offset = (query.page - 1) * query.per_page;
      return json(
        c,
        developmentRepositoryListSchema.parse({
          items: matching.slice(offset, offset + query.per_page),
        }),
      );
    } catch (error) {
      console.error('failed to list development repositories', error);
      return apiError(c, 503, 'repository catalog is unavailable', 'CATALOG_UNAVAILABLE');
    }
  });
  app.openapi(listRoute, (c) =>
    json(
      c,
      developmentRunListSchema.parse({ items: database.development.listRuns().map(summary) }),
    ),
  );
  app.openapi(createRunRoute, async (c) => {
    if (
      hooks.onDevelopmentRunCreated === undefined ||
      hooks.validateDevelopmentRepository === undefined
    ) {
      return apiError(c, 409, 'development runtime is not configured', 'DEVELOPMENT_UNAVAILABLE');
    }
    const input = c.req.valid('json');
    let accessible: boolean;
    try {
      accessible = await hooks.validateDevelopmentRepository(input.repository);
    } catch (error) {
      console.error('failed to validate development repository', error);
      return apiError(c, 503, 'repository access could not be verified', 'GITHUB_UNAVAILABLE');
    }
    if (!accessible) {
      return apiError(
        c,
        409,
        'repository is not accessible to the GitHub App',
        'REPOSITORY_UNAVAILABLE',
      );
    }
    const run = database.development.createRun({
      repository: input.repository,
      goal: input.goal,
      ...(input.external_source === undefined
        ? {}
        : {
            externalSource: {
              provider: input.external_source.provider,
              id: input.external_source.id,
              ...(input.external_source.key === null ? {} : { key: input.external_source.key }),
              ...(input.external_source.url === null ? {} : { url: input.external_source.url }),
            },
          }),
    });
    hooks.onDevelopmentRunCreated(run.id);
    return json(c, developmentRunSummarySchema.parse(summary(run)), 201);
  });
  app.openapi(detailRoute, (c) => {
    const run = database.development.getRun(c.req.valid('param').runId);
    if (run === undefined) {
      return apiError(c, 404, 'development run not found', 'NOT_FOUND');
    }
    return json(c, detail(database, run));
  });
  app.openapi(answerClarificationRoute, (c) => {
    const runId = c.req.valid('param').runId;
    if (database.development.getRun(runId) === undefined) {
      return apiError(c, 404, 'development run not found', 'NOT_FOUND');
    }
    if (hooks.onDevelopmentClarificationAnswer === undefined) {
      return apiError(c, 409, 'development runtime is not configured', 'DEVELOPMENT_UNAVAILABLE');
    }
    const input = c.req.valid('json');
    try {
      hooks.onDevelopmentClarificationAnswer({
        runId,
        interruptId: input.interrupt_id,
        interruptLockVersion: input.expected_lock_version,
        answers: input.answers,
      });
      return json(
        c,
        developmentRunSummarySchema.parse(summary(database.development.requireRun(runId))),
        202,
      );
    } catch (error) {
      if (error instanceof Error) {
        return apiError(c, 409, error.message, 'STALE_DEVELOPMENT_STATE');
      }
      throw error;
    }
  });
  app.openapi(approvePlanRoute, (c) => {
    const runId = c.req.valid('param').runId;
    const run = database.development.getRun(runId);
    if (run === undefined) {
      return apiError(c, 404, 'development run not found', 'NOT_FOUND');
    }
    if (hooks.onDevelopmentPlanApproval === undefined) {
      return apiError(c, 409, 'development runtime is not configured', 'DEVELOPMENT_UNAVAILABLE');
    }
    const input = c.req.valid('json');
    try {
      hooks.onDevelopmentPlanApproval({
        runId,
        interruptId: input.interrupt_id,
        interruptLockVersion: input.expected_lock_version,
        approve: input.approve,
        ...(input.response === undefined ? {} : { response: input.response }),
      });
      return json(
        c,
        developmentRunSummarySchema.parse(summary(database.development.requireRun(runId))),
        202,
      );
    } catch (error) {
      if (error instanceof DevelopmentConflictError || error instanceof Error) {
        return apiError(c, 409, error.message, 'STALE_DEVELOPMENT_STATE');
      }
      throw error;
    }
  });
  app.openapi(streamRoute, (c) => {
    const runId = c.req.valid('param').runId;
    if (database.development.getRun(runId) === undefined) {
      return apiError(c, 404, 'development run not found', 'NOT_FOUND');
    }
    const headerSequence = Number(c.req.header('Last-Event-ID') ?? '0');
    let sequence = Math.max(
      c.req.valid('query').after,
      Number.isSafeInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0,
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    return streamSSE(c, async (stream) => {
      let previousState = '';
      let ticks = 0;
      while (!stream.aborted) {
        const run = database.development.getRun(runId);
        if (run === undefined) {
          return;
        }
        for (const event of database.development.listEvents(runId, sequence)) {
          const normalized = developmentEventSchema.parse({
            schema_version: 1,
            sequence: event.sequence,
            generation: event.generation,
            observed_at: event.observedAt,
            type: event.type,
            source: event.source.toLowerCase(),
            trust: event.trust.toLowerCase(),
            payload: event.payload,
          });
          await stream.writeSSE({
            data: JSON.stringify(normalized),
            event: 'development-event',
            id: String(event.sequence),
          });
          sequence = event.sequence;
        }
        const current = detail(database, run);
        const stateKey = `${run.phase}:${run.generation}:${run.lockVersion}`;
        if (stateKey !== previousState || terminal(run.phase)) {
          await stream.writeSSE({ data: JSON.stringify(current), event: 'snapshot' });
          previousState = stateKey;
        }
        if (terminal(run.phase)) {
          return;
        }
        ticks += 1;
        if (ticks % 15 === 0) {
          await stream.write(': heartbeat\n\n');
        }
        await stream.sleep(1_000);
      }
    });
  });
  app.openapi(approvePublicationRoute, (c) => {
    const runId = c.req.valid('param').runId;
    if (database.development.getRun(runId) === undefined) {
      return apiError(c, 404, 'development run not found', 'NOT_FOUND');
    }
    if (hooks.onDevelopmentPublicationApproval === undefined) {
      return apiError(c, 409, 'development runtime is not configured', 'DEVELOPMENT_UNAVAILABLE');
    }
    const input = c.req.valid('json');
    try {
      hooks.onDevelopmentPublicationApproval({
        runId,
        interruptId: input.interrupt_id,
        interruptLockVersion: input.expected_lock_version,
        candidateHash: input.candidate_hash,
        approve: input.approve,
        ...(input.response === undefined ? {} : { response: input.response }),
      });
      return json(
        c,
        developmentRunSummarySchema.parse(summary(database.development.requireRun(runId))),
        202,
      );
    } catch (error) {
      if (error instanceof Error) {
        return apiError(c, 409, error.message, 'STALE_DEVELOPMENT_STATE');
      }
      throw error;
    }
  });
}

function detail(database: JobDatabase, run: DevelopmentRun) {
  const interrupt = database.development.getOpenInterrupt(run.id);
  const external = database.developmentProjections.getExternalStatus(run.id);
  return developmentRunDetailSchema.parse({
    run: summary(run),
    events: database.development.listEvents(run.id).map((event) =>
      developmentEventSchema.parse({
        schema_version: 1,
        sequence: event.sequence,
        generation: event.generation,
        observed_at: event.observedAt,
        type: event.type,
        source: event.source.toLowerCase(),
        trust: event.trust.toLowerCase(),
        payload: event.payload,
      }),
    ),
    interrupt:
      interrupt === undefined
        ? null
        : developmentInterruptSchema.parse({
            id: interrupt.id,
            kind: interrupt.kind.toLowerCase(),
            status: 'open',
            prompt: interrupt.prompt,
            questions:
              interrupt.questions?.map((question) => ({
                id: question.id,
                header: question.header,
                question: question.question,
                is_other: question.isOther,
                options: question.options ?? null,
              })) ?? null,
            candidate_hash: interrupt.candidateHash ?? null,
            publication_kind: interrupt.publicationKind?.toLowerCase() ?? null,
            lock_version: interrupt.lockVersion,
            requested_at: interrupt.requestedAt,
            resolved_at: null,
          }),
    evidence: database.development.listEvidence(run.id).map((evidence) =>
      developmentEvidenceSchema.parse({
        id: evidence.id,
        criterion: evidence.criterion,
        method: evidence.method.toLowerCase(),
        observation: evidence.observation,
        trust: evidence.trust.toLowerCase(),
        verdict: evidence.verdict.toLowerCase(),
        candidate_hash: evidence.candidateHash,
        created_at: evidence.createdAt,
      }),
    ),
    external_source:
      external === undefined
        ? null
        : {
            provider: external.source.provider,
            id: external.source.id,
            key: external.source.key,
            url: external.source.url,
          },
    external_sync:
      external?.sync === null || external?.sync === undefined
        ? null
        : {
            status: external.sync.status,
            state: external.sync.state.toLowerCase(),
            last_error: external.sync.lastError,
            updated_at: external.sync.updatedAt,
          },
  });
}

function summary(run: DevelopmentRun) {
  const phase = run.phase.toLowerCase();
  return {
    id: run.id,
    workflow: 'development-v1' as const,
    repository: run.repository,
    phase,
    prior_phase: run.priorPhase?.toLowerCase() ?? null,
    generation: run.generation,
    revision: run.revision,
    goal: run.goal,
    candidate_hash: run.candidateHash ?? null,
    operator_action:
      phase === 'waiting_for_input'
        ? ('answer' as const)
        : phase === 'awaiting_plan_approval'
          ? ('approve_plan' as const)
          : phase === 'awaiting_publication_approval'
            ? ('approve_publication' as const)
            : null,
    last_activity_at: run.lastActivityAt,
    created_at: run.createdAt,
    updated_at: run.updatedAt,
  };
}

function terminal(phase: DevelopmentRun['phase']): boolean {
  return ['COMPLETED', 'FAILED', 'CANCELLED'].includes(phase);
}
