import type { DatabaseSync } from 'node:sqlite';
import { transaction } from './connection.js';
import {
  DevelopmentConflictError,
  type DevelopmentRunCreateInput,
  developmentInputKey,
} from './development-input.js';

export function createDevelopmentRun(
  database: DatabaseSync,
  input: DevelopmentRunCreateInput,
  insertCreatedEvent: (runId: number, now: string, source: 'web' | 'ticket') => void,
): number {
  const now = input.now ?? new Date().toISOString();
  return transaction(database, () => {
    const inputKey = developmentInputKey(input);
    const duplicate = database
      .prepare(`SELECT r.id
        FROM development_runs r
        JOIN development_work_revisions w ON w.id = r.accepted_work_revision_id
        WHERE json_extract(w.normalized_json, '$.input_key') = ?
          AND r.phase NOT IN ('COMPLETED','FAILED','CANCELLED')
        ORDER BY r.id DESC LIMIT 1`)
      .get(inputKey) as { id: number } | undefined;
    if (duplicate !== undefined) {
      throw new DevelopmentConflictError(
        `development run ${duplicate.id} already owns this accepted input`,
      );
    }
    const result = database
      .prepare(`INSERT INTO development_runs (
        repository, phase, generation, lock_version, last_activity_at, created_at, updated_at
      ) VALUES (?, 'INTAKE', 1, 1, ?, ?, ?)`)
      .run(input.repository, now, now, now);
    const runId = Number(result.lastInsertRowid);
    const source = input.externalSource;
    const revision = database
      .prepare(`INSERT INTO development_work_revisions (
        run_id, revision, source_kind, goal, normalized_json,
        source_provider, source_external_id, source_external_key, source_url, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        runId,
        source === undefined ? 'WEB' : 'TICKET',
        input.goal,
        JSON.stringify({
          checkout: input.checkout,
          goal: input.goal,
          input_key: inputKey,
          repository: input.repository,
        }),
        source?.provider ?? null,
        source?.id ?? null,
        source?.key ?? null,
        source?.url ?? null,
        now,
      );
    database
      .prepare('UPDATE development_runs SET accepted_work_revision_id = ? WHERE id = ?')
      .run(Number(revision.lastInsertRowid), runId);
    if (source !== undefined) {
      database
        .prepare(`INSERT INTO development_external_refs (
          run_id, provider, kind, external_id, external_key, url, created_at, updated_at
        ) VALUES (?, ?, 'TICKET', ?, ?, ?, ?, ?)`)
        .run(runId, source.provider, source.id, source.key ?? null, source.url ?? null, now, now);
    }
    insertCreatedEvent(runId, now, source === undefined ? 'web' : 'ticket');
    return runId;
  });
}
