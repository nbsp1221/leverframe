import type { DevelopmentProjectionRepository } from '../storage/development-projection-repository.js';
import type { DevelopmentPhase, DevelopmentRepository } from '../storage/development-repository.js';
import type { TicketAdapter, TicketProjectionStatus } from './adapter.js';
import { isTicketProjectionStatus } from './adapter.js';

export class TicketProjectionWorker {
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(
    private readonly options: {
      adapter: TicketAdapter;
      database: DevelopmentRepository;
      projections: DevelopmentProjectionRepository;
      intervalMs?: number;
    },
  ) {}

  start(): void {
    if (this.#timer !== undefined) {
      return;
    }
    this.#timer = setInterval(() => void this.#tick(), this.options.intervalMs ?? 10_000);
    this.#timer.unref();
    void this.#tick();
  }

  async stop(): Promise<void> {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
    }
    this.#timer = undefined;
    while (this.#running) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }

  async #tick(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    try {
      for (const run of this.options.database.listRuns()) {
        const externalId = this.options.projections.getTicketExternalId(run.id, 'multica');
        if (externalId !== undefined) {
          this.options.projections.enqueue(
            run.id,
            'multica',
            externalId,
            projectionStatus(run.phase),
          );
        }
      }
      for (;;) {
        const intent = this.options.projections.claim('multica');
        if (intent === undefined) {
          break;
        }
        try {
          if (!isTicketProjectionStatus(intent.status)) {
            throw new Error(`unsupported ticket projection status: ${intent.status}`);
          }
          await this.options.adapter.projectStatus(intent.externalId, intent.status);
          this.options.projections.finish(intent.id, true);
        } catch (error) {
          this.options.projections.finish(
            intent.id,
            false,
            error instanceof Error ? error.message : String(error),
          );
          break;
        }
      }
    } finally {
      this.#running = false;
    }
  }
}

function projectionStatus(phase: DevelopmentPhase): TicketProjectionStatus {
  if (
    ['WAITING_FOR_INPUT', 'AWAITING_PLAN_APPROVAL', 'AWAITING_PUBLICATION_APPROVAL'].includes(phase)
  ) {
    return 'waiting_for_operator';
  }
  if (['REVIEWING', 'AWAITING_MERGE'].includes(phase)) {
    return 'pr_linked';
  }
  if (['VERIFYING', 'PUBLISHING'].includes(phase)) {
    return 'candidate_verified';
  }
  if (phase === 'COMPLETED') {
    return 'completed';
  }
  if (['FAILED', 'CANCELLED'].includes(phase)) {
    return 'failed';
  }
  return 'started';
}
