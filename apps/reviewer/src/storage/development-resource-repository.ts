import type { DatabaseSync } from 'node:sqlite';

export type DevelopmentResourceKind = 'SANDBOX' | 'WORKSPACE' | 'BRANCH' | 'PREVIEW';

export type DevelopmentResourceState =
  | 'PROVISIONING'
  | 'ACTIVE'
  | 'STOPPED'
  | 'RETAINED'
  | 'CLEANUP_PENDING'
  | 'CLEANUP_FAILED'
  | 'CLEANED'
  | 'UNKNOWN';

export interface DevelopmentResource {
  kind: DevelopmentResourceKind;
  provider: string;
  externalId: string;
  state: DevelopmentResourceState;
  generation: number;
  lastError: string | null;
  observedAt: string;
  updatedAt: string;
}

export class DevelopmentResourceRepository {
  constructor(private readonly database: DatabaseSync) {}

  list(runId: number): DevelopmentResource[] {
    return (
      this.database
        .prepare(`SELECT kind, provider, external_id, state, generation, last_error, observed_at, updated_at
          FROM development_resources WHERE run_id = ? ORDER BY id`)
        .all(runId) as Array<{
        kind: DevelopmentResourceKind;
        provider: string;
        external_id: string;
        state: DevelopmentResourceState;
        generation: number;
        last_error: string | null;
        observed_at: string;
        updated_at: string;
      }>
    ).map((row) => ({
      kind: row.kind,
      provider: row.provider,
      externalId: row.external_id,
      state: row.state,
      generation: row.generation,
      lastError: row.last_error,
      observedAt: row.observed_at,
      updatedAt: row.updated_at,
    }));
  }

  observe(input: {
    runId: number;
    kind: DevelopmentResourceKind;
    provider: string;
    externalId: string;
    state: DevelopmentResourceState;
    generation: number;
    error?: string;
    now?: string;
  }): void {
    const now = input.now ?? new Date().toISOString();
    this.database
      .prepare(`INSERT INTO development_resources (
        run_id, kind, provider, external_id, state, generation, last_error,
        observed_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, kind) DO UPDATE SET
        provider = excluded.provider,
        external_id = excluded.external_id,
        state = excluded.state,
        generation = excluded.generation,
        last_error = excluded.last_error,
        observed_at = excluded.observed_at,
        updated_at = excluded.updated_at`)
      .run(
        input.runId,
        input.kind,
        input.provider,
        input.externalId,
        input.state,
        input.generation,
        input.error?.slice(0, 4000) ?? null,
        now,
        now,
        now,
      );
  }
}
