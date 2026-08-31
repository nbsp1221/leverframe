import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './connection.js';

export interface DevelopmentProjectionIntent {
  id: number;
  runId: number;
  externalId: string;
  status: string;
}

export interface DevelopmentExternalStatus {
  source: { provider: string; id: string; key: string | null; url: string | null };
  sync: { status: string; state: string; lastError: string | null; updatedAt: string } | null;
}

export class DevelopmentProjectionRepository {
  constructor(private readonly database: DatabaseSync) {}

  getTicketExternalId(runId: number, provider: string): string | undefined {
    const row = this.database
      .prepare(
        "SELECT external_id FROM development_external_refs WHERE run_id = ? AND provider = ? AND kind = 'TICKET'",
      )
      .get(runId, provider) as { external_id: string } | undefined;
    return row?.external_id;
  }

  getExternalStatus(runId: number): DevelopmentExternalStatus | undefined {
    const source = this.database
      .prepare(`SELECT provider, external_id, external_key, url
        FROM development_external_refs
        WHERE run_id = ? AND kind = 'TICKET'
        ORDER BY id LIMIT 1`)
      .get(runId) as
      | { provider: string; external_id: string; external_key: string | null; url: string | null }
      | undefined;
    if (source === undefined) {
      return undefined;
    }
    const intent = this.database
      .prepare(`SELECT state, request_json, last_error, updated_at
        FROM development_outbound_intents
        WHERE run_id = ? AND provider = ? AND operation = 'project_status'
        ORDER BY id DESC LIMIT 1`)
      .get(runId, source.provider) as
      | { state: string; request_json: string; last_error: string | null; updated_at: string }
      | undefined;
    const request =
      intent === undefined ? undefined : (JSON.parse(intent.request_json) as { status: string });
    return {
      source: {
        provider: source.provider,
        id: source.external_id,
        key: source.external_key,
        url: source.url,
      },
      sync:
        intent === undefined || request === undefined
          ? null
          : {
              status: request.status,
              state: intent.state,
              lastError: intent.last_error,
              updatedAt: intent.updated_at,
            },
    };
  }

  enqueue(runId: number, provider: string, externalId: string, status: string): void {
    const now = new Date().toISOString();
    this.database
      .prepare(`INSERT OR IGNORE INTO development_outbound_intents (
      run_id, provider, operation, idempotency_key, state, request_json, created_at, updated_at
    ) VALUES (?, ?, 'project_status', ?, 'PENDING', ?, ?, ?)`)
      .run(
        runId,
        provider,
        `${runId}:status:${status}`,
        JSON.stringify({ externalId, status }),
        now,
        now,
      );
  }

  claim(provider: string): DevelopmentProjectionIntent | undefined {
    return transaction(this.database, () => {
      const row = this.database
        .prepare(`SELECT id, run_id, request_json FROM development_outbound_intents
        WHERE provider = ? AND operation = 'project_status' AND state IN ('PENDING','UNKNOWN') ORDER BY id LIMIT 1`)
        .get(provider) as { id: number; run_id: number; request_json: string } | undefined;
      if (row === undefined) {
        return undefined;
      }
      const result = this.database
        .prepare(
          "UPDATE development_outbound_intents SET state = 'PERFORMING', attempts = attempts + 1, updated_at = ? WHERE id = ? AND state IN ('PENDING','UNKNOWN')",
        )
        .run(new Date().toISOString(), row.id);
      if (result.changes !== 1) {
        return undefined;
      }
      const request = JSON.parse(row.request_json) as { externalId: string; status: string };
      return {
        id: row.id,
        runId: row.run_id,
        externalId: request.externalId,
        status: request.status,
      };
    });
  }

  finish(id: number, confirmed: boolean, error?: string): void {
    this.database
      .prepare(
        "UPDATE development_outbound_intents SET state = ?, last_error = ?, updated_at = ? WHERE id = ? AND state = 'PERFORMING'",
      )
      .run(
        confirmed ? 'CONFIRMED' : 'UNKNOWN',
        error?.slice(0, 4000) ?? null,
        new Date().toISOString(),
        id,
      );
  }
}
