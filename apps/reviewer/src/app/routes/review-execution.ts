import { type OpenAPIHono, createRoute } from '@hono/zod-openapi';
import {
  errorResponseSchema,
  reviewExecutionQuerySchema,
  reviewExecutionSnapshotSchema,
  reviewIdParamsSchema,
} from '@repo/contracts';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { ExecutionTraceStore } from '../../execution/trace.js';
import type { JobDatabase, ReviewJob } from '../../jobs/database.js';
import { apiError, mapStatus } from '../server-common.js';

const getExecutionRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/{reviewId}/execution',
  operationId: 'getReviewExecution',
  tags: ['Reviews'],
  summary: 'Get a bounded review execution trace',
  description:
    'Returns durable review state plus bounded, redacted observable Codex activity. It never returns raw reasoning, a full transcript, a full diff, or unbounded command output.',
  request: { params: reviewIdParamsSchema },
  responses: {
    200: {
      description: 'The current execution snapshot and retained normalized events.',
      content: { 'application/json': { schema: reviewExecutionSnapshotSchema } },
    },
    404: {
      description: 'The requested review was not found.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    422: {
      description: 'The review ID is invalid.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

const streamExecutionRoute = createRoute({
  method: 'get',
  path: '/api/v1/reviews/{reviewId}/execution/events',
  operationId: 'streamReviewExecution',
  tags: ['Reviews'],
  summary: 'Follow bounded review execution events',
  description:
    'Replays normalized events after the requested sequence and follows new activity with Server-Sent Events until the review reaches a terminal state.',
  request: { params: reviewIdParamsSchema, query: reviewExecutionQuerySchema },
  responses: {
    200: {
      description: 'A resumable Server-Sent Events stream.',
      content: { 'text/event-stream': { schema: z.string() } },
    },
    404: {
      description: 'The requested review was not found.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
    422: {
      description: 'The review ID or sequence is invalid.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function registerReviewExecutionRoutes(
  app: OpenAPIHono,
  database: JobDatabase,
  traceStore: ExecutionTraceStore,
  recordRead: () => void,
): void {
  app.openapi(getExecutionRoute, (c) => {
    const id = c.req.valid('param').reviewId;
    const job = database.getReviewJob(id);
    if (job === undefined) {
      return apiError(c, 404, 'review not found', 'NOT_FOUND');
    }
    c.header('Cache-Control', 'no-store');
    recordRead();
    return c.json(snapshot(job, traceStore), 200);
  });

  app.openapi(streamExecutionRoute, (c) => {
    const id = c.req.valid('param').reviewId;
    const initialJob = database.getReviewJob(id);
    if (initialJob === undefined) {
      return apiError(c, 404, 'review not found', 'NOT_FOUND');
    }
    const headerSequence = Number(c.req.header('Last-Event-ID') ?? '0');
    let sequence = Math.max(
      c.req.valid('query').after,
      Number.isSafeInteger(headerSequence) && headerSequence >= 0 ? headerSequence : 0,
    );
    c.header('Cache-Control', 'no-store');
    c.header('X-Accel-Buffering', 'no');
    recordRead();
    return streamSSE(c, async (stream) => {
      let previousState = '';
      let ticks = 0;
      while (!stream.aborted) {
        const job = database.getReviewJob(id);
        if (job === undefined) {
          return;
        }
        const current = snapshot(job, traceStore);
        for (const event of current.events) {
          if (event.sequence <= sequence) {
            continue;
          }
          await stream.writeSSE({
            data: JSON.stringify(event),
            event: 'trace',
            id: String(event.sequence),
          });
          sequence = event.sequence;
        }
        const stateKey = `${current.status}:${current.stage}:${current.attempt}:${current.available}`;
        if (previousState !== stateKey || terminal(current.status)) {
          await stream.writeSSE({
            data: JSON.stringify({ ...current, events: [] }),
            event: 'snapshot',
          });
          previousState = stateKey;
        }
        if (terminal(current.status)) {
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
}

function snapshot(job: ReviewJob, traceStore: ExecutionTraceStore) {
  const trace = traceStore.read(job.id, job.attempt ?? 0);
  return reviewExecutionSnapshotSchema.parse({
    review_id: job.id,
    available: trace.available,
    unavailable_reason: trace.unavailableReason,
    attempt: job.attempt ?? 0,
    status: mapStatus(job.state),
    stage: executionStage(job.state),
    started_at: trace.startedAt,
    process_heartbeat_at: trace.processHeartbeatAt,
    last_activity_at: trace.lastActivityAt,
    last_sequence: trace.lastSequence,
    trace_truncated: trace.traceTruncated,
    current_command: trace.currentCommand,
    events: trace.events,
  });
}

function executionStage(value: string) {
  const normalized = value.toLowerCase();
  return [
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
  ].includes(normalized)
    ? normalized
    : 'unknown';
}

function terminal(status: ReturnType<typeof mapStatus>): boolean {
  return ['completed', 'failed', 'superseded', 'cancelled'].includes(status);
}
