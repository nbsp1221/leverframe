import { DatabaseSync } from 'node:sqlite';
import { type Decision, decisionSchema } from '@repo/contracts/decisions';
import type { DecisionRepository } from './ports.js';

/** Dedicated storage: the preview never opens the review worker's production database. */
export class SqliteDecisionRepository implements DecisionRepository {
  readonly #database: DatabaseSync;
  constructor(path: string) {
    this.#database = new DatabaseSync(path);
    this.#database.exec(
      'PRAGMA journal_mode = WAL; CREATE TABLE IF NOT EXISTS decisions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)',
    );
    this.#database.exec(
      'CREATE TABLE IF NOT EXISTS decision_creations (id TEXT PRIMARY KEY, hash TEXT NOT NULL); CREATE TABLE IF NOT EXISTS decision_deliveries (id TEXT PRIMARY KEY, hash TEXT NOT NULL)',
    );
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
      .run(item.id, item.revision, JSON.stringify(decisionSchema.parse(item)));
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
  /** Reserve before sending. A persisted reservation without a receipt stays uncertain. */
  reserveDelivery(id: string, hash: string): boolean {
    const previous = this.#database
      .prepare('SELECT hash FROM decision_deliveries WHERE id = ?')
      .get(id);
    if (previous && previous.hash !== hash) {
      throw new Error('delivery_payload_changed');
    }
    return (
      this.#database
        .prepare('INSERT OR IGNORE INTO decision_deliveries (id, hash) VALUES (?, ?)')
        .run(id, hash).changes === 1
    );
  }
  replace(item: Decision, expectedRevision: number): boolean {
    const result = this.#database
      .prepare('UPDATE decisions SET revision = ?, body = ? WHERE id = ? AND revision = ?')
      .run(item.revision, JSON.stringify(decisionSchema.parse(item)), item.id, expectedRevision);
    return result.changes === 1;
  }
  close(): void {
    this.#database.close();
  }
}
