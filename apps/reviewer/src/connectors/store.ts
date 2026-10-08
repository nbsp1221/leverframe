import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { Connector, ConnectorCommand, ConnectorResult } from '@repo/contracts/connectors';
import { connectorHealthSchema } from '@repo/contracts/connectors';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

interface Row {
  id: string;
  name: string;
  hostname: string;
  revoked: number;
  last_seen: number | null;
  health: string;
  question_at: number | null;
  delivered_at: number | null;
}

const iso = (value: number | null) => (value === null ? null : new Date(value).toISOString());

/** Enrollment and mailbox persistence. Agent secrets are stored only as hashes. */
export class ConnectorStore {
  private readonly db: DatabaseSync;
  constructor(
    path: string,
    private readonly now = Date.now,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS connector_pairings (id TEXT PRIMARY KEY, hash TEXT UNIQUE, expires INTEGER NOT NULL, connector_id TEXT);
      CREATE TABLE IF NOT EXISTS connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, hostname TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, health TEXT NOT NULL, question_at INTEGER, delivered_at INTEGER);
      CREATE TABLE IF NOT EXISTS connector_sessions (connector_id TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, PRIMARY KEY(connector_id, session_id));
      CREATE TABLE IF NOT EXISTS connector_aliases (legacy_id TEXT PRIMARY KEY, connector_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connector_commands (id TEXT PRIMARY KEY, connector_id TEXT NOT NULL, payload TEXT NOT NULL, state TEXT NOT NULL, expires INTEGER NOT NULL, result TEXT);
    `);
  }
  pair() {
    const code = randomBytes(24).toString('base64url');
    const id = randomUUID();
    const expires = this.now() + 10 * 60_000;
    this.db
      .prepare('INSERT INTO connector_pairings VALUES (?, ?, ?, NULL)')
      .run(id, hash(code), expires);
    return { id, code, expiresAt: new Date(expires).toISOString() };
  }
  enroll(code: string, name: string, hostname: string) {
    const id = `connector-${randomUUID()}`;
    const token = randomBytes(32).toString('base64url');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const changed = this.db
        .prepare(
          'UPDATE connector_pairings SET connector_id = ? WHERE hash = ? AND expires > ? AND connector_id IS NULL',
        )
        .run(id, hash(code), this.now());
      if (!changed.changes) {
        throw new Error('pairing_expired_or_used');
      }
      this.db
        .prepare('INSERT INTO connectors (id,name,hostname,token_hash,health) VALUES (?,?,?,?,?)')
        .run(
          id,
          name,
          hostname,
          hash(token),
          JSON.stringify({ codex: 'unavailable', skill: 'missing' }),
        );
      this.db.exec('COMMIT');
      return { id, token };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  pairing(id: string) {
    const row = this.db
      .prepare('SELECT expires, connector_id FROM connector_pairings WHERE id = ?')
      .get(id) as { expires: number; connector_id: string | null } | undefined;
    return row
      ? {
          status: row.connector_id ? 'connected' : row.expires > this.now() ? 'waiting' : 'expired',
          connectorId: row.connector_id,
        }
      : null;
  }
  authenticate(token: string): string | undefined {
    const row = this.db
      .prepare('SELECT id FROM connectors WHERE token_hash=? AND revoked=0')
      .get(hash(token)) as { id: string } | undefined;
    return row?.id;
  }
  heartbeat(id: string, health: unknown) {
    this.db
      .prepare('UPDATE connectors SET last_seen=?, health=? WHERE id=? AND revoked=0')
      .run(this.now(), JSON.stringify(connectorHealthSchema.parse(health)), id);
  }
  list(): Connector[] {
    return (
      this.db.prepare('SELECT * FROM connectors ORDER BY rowid DESC').all() as unknown as Row[]
    ).map((row) => ({
      id: row.id,
      name: row.name,
      hostname: row.hostname,
      status: row.revoked
        ? 'revoked'
        : row.last_seen !== null && this.now() - row.last_seen < 15_000
          ? 'online'
          : 'offline',
      lastSeenAt: iso(row.last_seen),
      health: connectorHealthSchema.parse(JSON.parse(row.health)),
      sessionCount: this.sessions(row.id).size,
      lastQuestionAt: iso(row.question_at),
      lastDeliveredAt: iso(row.delivered_at),
    }));
  }
  active(id: string): boolean {
    return Boolean(this.db.prepare('SELECT id FROM connectors WHERE id=? AND revoked=0').get(id));
  }
  revoke(id: string) {
    this.db.prepare('UPDATE connectors SET revoked=1 WHERE id=?').run(id);
    this.db
      .prepare(
        "UPDATE connector_commands SET state='expired' WHERE connector_id=? AND state='pending'",
      )
      .run(id);
  }
  sessions(id: string): Map<string, string> {
    const rows = this.db
      .prepare('SELECT session_id,cwd FROM connector_sessions WHERE connector_id=?')
      .all(id) as { session_id: string; cwd: string }[];
    return new Map(rows.map((row) => [row.session_id, row.cwd]));
  }
  bind(id: string, sessionId: string, cwd: string) {
    if (!this.active(id)) {
      throw new Error('connector_revoked');
    }
    this.db
      .prepare('INSERT OR IGNORE INTO connector_sessions VALUES (?,?,?)')
      .run(id, sessionId, cwd);
    if (this.sessions(id).get(sessionId) !== cwd) {
      throw new Error('session_identity_changed');
    }
  }
  aliases(): { legacy_id: string; connector_id: string }[] {
    return this.db.prepare('SELECT legacy_id,connector_id FROM connector_aliases').all() as {
      legacy_id: string;
      connector_id: string;
    }[];
  }
  adoptLegacy(legacyId: string, id: string) {
    if (legacyId.startsWith('connector-') || !this.active(id)) {
      throw new Error('invalid_legacy_route');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const previous = this.aliases().find((alias) => alias.legacy_id === legacyId);
      if (previous && previous.connector_id !== id) {
        throw new Error('legacy_route_already_migrated');
      }
      if (
        this.db.prepare("SELECT name FROM sqlite_master WHERE name='decision_session_locks'").get()
      ) {
        const rows = this.db
          .prepare('SELECT session_key,delivery_id FROM decision_session_locks')
          .all() as { session_key: string; delivery_id: string }[];
        for (const row of rows) {
          const [connection, session] = JSON.parse(row.session_key) as string[];
          if (connection === legacyId) {
            this.db
              .prepare('UPDATE decision_session_locks SET session_key=? WHERE session_key=?')
              .run(JSON.stringify([id, session]), row.session_key);
          }
        }
      }
      this.db.prepare('INSERT OR IGNORE INTO connector_aliases VALUES (?,?)').run(legacyId, id);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  recordQuestion(id: string) {
    this.db.prepare('UPDATE connectors SET question_at=? WHERE id=?').run(this.now(), id);
  }
  recordDelivery(id: string) {
    this.db.prepare('UPDATE connectors SET delivered_at=? WHERE id=?').run(this.now(), id);
  }
  enqueue(id: string, command: Omit<ConnectorCommand, 'id'>, timeout: number) {
    if (!this.active(id)) {
      throw new Error('connector_revoked');
    }
    const payload = { ...command, id: randomUUID() };
    this.db
      .prepare("INSERT INTO connector_commands VALUES (?,?,?,'pending',?,NULL)")
      .run(payload.id, id, JSON.stringify(payload), this.now() + timeout);
    return payload.id;
  }
  claim(id: string): ConnectorCommand[] {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          "UPDATE connector_commands SET state='expired' WHERE state='pending' AND expires<=?",
        )
        .run(this.now());
      const rows = this.db
        .prepare(
          "SELECT id,payload FROM connector_commands WHERE connector_id=? AND state='pending' LIMIT 4",
        )
        .all(id) as { id: string; payload: string }[];
      for (const row of rows) {
        this.db.prepare("UPDATE connector_commands SET state='claimed' WHERE id=?").run(row.id);
      }
      this.db.exec('COMMIT');
      return rows.map((row) => JSON.parse(row.payload) as ConnectorCommand);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
  canExecute(id: string, commandId: string): boolean {
    return (
      this.active(id) &&
      Boolean(
        this.db
          .prepare(
            "SELECT id FROM connector_commands WHERE id=? AND connector_id=? AND state='claimed' AND expires>?",
          )
          .get(commandId, id, this.now()),
      )
    );
  }
  complete(id: string, commandId: string, result: ConnectorResult) {
    // Claimed commands are never issued again, even after a lost response or process restart.
    this.db
      .prepare(
        "UPDATE connector_commands SET state='completed',result=? WHERE id=? AND connector_id=? AND state='claimed'",
      )
      .run(JSON.stringify(result), commandId, id);
  }
  result(id: string): ConnectorResult | undefined {
    const row = this.db.prepare('SELECT result FROM connector_commands WHERE id=?').get(id) as
      | { result: string | null }
      | undefined;
    return row?.result ? (JSON.parse(row.result) as ConnectorResult) : undefined;
  }
  expire(id: string) {
    this.db
      .prepare("UPDATE connector_commands SET state='expired' WHERE id=? AND state='pending'")
      .run(id);
  }
  close() {
    this.db.close();
  }
}
