import { DatabaseSync } from 'node:sqlite';
import { type Decision, decisionSchema } from '@repo/contracts/decisions';
import type { DecisionRepository, DeliveryJournal } from './ports.js';

/** Dedicated inbox database. Migration preserves legacy creation and delivery identities. */
export class SqliteDecisionRepository implements DecisionRepository, DeliveryJournal {
  readonly #database: DatabaseSync;
  constructor(
    path: string,
    private readonly legacyConnectionId = 'local-codex',
  ) {
    this.#database = new DatabaseSync(path);
    this.#database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000');
    const version = Number(this.#database.prepare('PRAGMA user_version').get()?.user_version);
    if (version > 1) {
      this.#database.close();
      throw new Error('unsupported_decision_database_version');
    }
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec(`
        CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decision_creations (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decision_deliveries (id TEXT PRIMARY KEY, hash TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS decision_session_locks (session_key TEXT PRIMARY KEY, delivery_id TEXT NOT NULL);
      `);
      if (version === 0) {
        this.#database.exec(
          "ALTER TABLE decision_deliveries ADD COLUMN state TEXT NOT NULL DEFAULT 'reserved'",
        );
        for (const item of this.list()) {
          this.#database
            .prepare('UPDATE decisions SET body = ? WHERE id = ?')
            .run(JSON.stringify(this.normalize(item)), item.id);
          const answer = item.answers.at(-1);
          if (answer && ['queued', 'delivery_failed'].includes(item.status)) {
            this.enqueue(item);
            if (this.deliveryReserved(`${item.id}:${answer.id}`)) {
              this.acquireSession(
                JSON.stringify([
                  item.context.connectionId ?? legacyConnectionId,
                  item.context.threadId,
                ]),
                `${item.id}:${answer.id}`,
              );
            }
          }
        }
        // Old binaries strip the new connection field. Refuse their writes after migration.
        this.#database.exec(`
          CREATE TRIGGER decisions_require_connection_insert BEFORE INSERT ON decisions
          WHEN json_extract(NEW.body, '$.context.connectionId') IS NULL BEGIN SELECT RAISE(ABORT, 'decision_database_requires_connection'); END;
          CREATE TRIGGER decisions_require_connection_update BEFORE UPDATE ON decisions
          WHEN json_extract(NEW.body, '$.context.connectionId') IS NULL BEGIN SELECT RAISE(ABORT, 'decision_database_requires_connection'); END;
          CREATE TRIGGER deliveries_require_state BEFORE INSERT ON decision_deliveries
          WHEN NEW.state = 'reserved' BEGIN SELECT RAISE(ABORT, 'legacy_delivery_writer_not_supported'); END;
          PRAGMA user_version = 1;
        `);
      }
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      this.#database.close();
      throw error;
    }
  }
  private normalize(item: Decision): Decision {
    return decisionSchema.parse({
      ...item,
      context: {
        ...item.context,
        connectionId:
          item.context.connectionId ??
          (item.context.agentId === 'codex'
            ? this.legacyConnectionId
            : `legacy-${item.context.agentId}`),
      },
    });
  }
  list(): Decision[] {
    return this.#database
      .prepare('SELECT body FROM decisions ORDER BY rowid')
      .all()
      .map((row) => decisionSchema.parse(JSON.parse(String(row.body))));
  }
  get(id: string): Decision | undefined {
    const row = this.#database.prepare('SELECT body FROM decisions WHERE id = ?').get(id);
    return row ? decisionSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  insert(item: Decision): void {
    this.#database
      .prepare('INSERT OR IGNORE INTO decisions (id, revision, body) VALUES (?, ?, ?)')
      .run(item.id, item.revision, JSON.stringify(this.normalize(item)));
  }
  creationHash(id: string): string | undefined {
    const row = this.#database.prepare('SELECT hash FROM decision_creations WHERE id = ?').get(id);
    return row ? String(row.hash) : undefined;
  }
  create(item: Decision, hash: string): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      if (this.get(item.id)) {
        this.#database.exec('ROLLBACK');
        return false;
      }
      this.insert(item);
      this.#database
        .prepare('INSERT INTO decision_creations (id, hash) VALUES (?, ?)')
        .run(item.id, hash);
      this.#database.exec('COMMIT');
      return true;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
  private enqueue(item: Decision): void {
    const answer = item.answers.at(-1);
    if (answer) {
      this.#database
        .prepare(
          "INSERT OR IGNORE INTO decision_deliveries (id, hash, state) VALUES (?, '', 'ready')",
        )
        .run(`${item.id}:${answer.id}`);
    }
  }
  reserveDelivery(id: string, hash: string): boolean {
    this.#database
      .prepare(
        "INSERT OR IGNORE INTO decision_deliveries (id, hash, state) VALUES (?, '', 'ready')",
      )
      .run(id);
    const previous = this.#database
      .prepare('SELECT hash FROM decision_deliveries WHERE id = ?')
      .get(id);
    if (previous?.hash && previous.hash !== hash) {
      throw new Error('delivery_payload_changed');
    }
    return (
      this.#database
        .prepare(
          "UPDATE decision_deliveries SET hash = ?, state = 'reserved' WHERE id = ? AND state = 'ready'",
        )
        .run(hash, id).changes === 1
    );
  }
  deliveryReserved(id: string): boolean {
    const row = this.#database
      .prepare('SELECT state FROM decision_deliveries WHERE id = ?')
      .get(id);
    return row?.state === 'reserved';
  }
  deliveryConfirmed(id: string): boolean {
    return (
      this.#database.prepare('SELECT state FROM decision_deliveries WHERE id = ?').get(id)
        ?.state === 'confirmed'
    );
  }
  confirmDelivery(id: string): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database
        .prepare("UPDATE decision_deliveries SET state = 'confirmed' WHERE id = ?")
        .run(id);
      this.#database.prepare('DELETE FROM decision_session_locks WHERE delivery_id = ?').run(id);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
  acquireSession(key: string, deliveryId: string): boolean {
    this.#database
      .prepare(
        'INSERT OR IGNORE INTO decision_session_locks (session_key, delivery_id) VALUES (?, ?)',
      )
      .run(key, deliveryId);
    return (
      this.#database
        .prepare('SELECT delivery_id FROM decision_session_locks WHERE session_key = ?')
        .get(key)?.delivery_id === deliveryId
    );
  }
  releaseSession(key: string, deliveryId: string): void {
    this.#database
      .prepare('DELETE FROM decision_session_locks WHERE session_key = ? AND delivery_id = ?')
      .run(key, deliveryId);
  }
  replace(item: Decision, expectedRevision: number): boolean {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.#database
        .prepare('UPDATE decisions SET revision = ?, body = ? WHERE id = ? AND revision = ?')
        .run(item.revision, JSON.stringify(this.normalize(item)), item.id, expectedRevision);
      if (result.changes === 1 && item.status === 'queued') {
        this.enqueue(item);
      }
      this.#database.exec('COMMIT');
      return result.changes === 1;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }
  close(): void {
    this.#database.close();
  }
}
