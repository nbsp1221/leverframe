import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  apply: (database: DatabaseSync) => void;
}

const baselineTables = `
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY, received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, policy_version TEXT NOT NULL, installation_id INTEGER NOT NULL,
  action TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
  state TEXT NOT NULL DEFAULT 'QUEUED', attempt INTEGER NOT NULL DEFAULT 0, error TEXT,
  check_run_id INTEGER, result_path TEXT, published_review_id INTEGER,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(repository, pull_request_number, head_sha, policy_version)
);
CREATE TABLE IF NOT EXISTS pull_request_state (
  repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL, status_comment_id INTEGER,
  current_job_id INTEGER NOT NULL REFERENCES review_jobs(id), current_head_sha TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY(repository, pull_request_number)
);
CREATE TABLE IF NOT EXISTS review_findings (
  repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL, fingerprint TEXT NOT NULL,
  file TEXT NOT NULL, line INTEGER NOT NULL, title TEXT NOT NULL, evidence TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('OPEN', 'STILL_PRESENT', 'FIXED')),
  first_seen_job_id INTEGER NOT NULL REFERENCES review_jobs(id), last_seen_job_id INTEGER NOT NULL REFERENCES review_jobs(id),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(repository, pull_request_number, fingerprint)
);
CREATE TABLE IF NOT EXISTS command_audits (
  delivery_id TEXT PRIMARY KEY, repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL, actor TEXT NOT NULL, command TEXT NOT NULL, outcome TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);`;

function columns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
}

function assertBaselineConstraints(database: DatabaseSync): void {
  const tableInfo = (table: string) =>
    database.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;

  const requireColumn = (
    table: string,
    name: string,
    type: string,
    notnull: boolean,
    pk?: number,
  ) => {
    const column = tableInfo(table).find((candidate) => candidate.name === name);
    if (
      column === undefined ||
      column.type.toUpperCase() !== type ||
      (notnull && column.notnull !== 1) ||
      (pk !== undefined && column.pk !== pk)
    ) {
      throw new Error(`incompatible ${table}.${name} column layout`);
    }
  };

  requireColumn('webhook_deliveries', 'delivery_id', 'TEXT', false, 1);
  requireColumn('review_jobs', 'id', 'INTEGER', false, 1);
  for (const [name, type] of [
    ['repository', 'TEXT'],
    ['pull_request_number', 'INTEGER'],
    ['head_sha', 'TEXT'],
    ['policy_version', 'TEXT'],
    ['installation_id', 'INTEGER'],
    ['action', 'TEXT'],
    ['delivery_id', 'TEXT'],
    ['state', 'TEXT'],
    ['attempt', 'INTEGER'],
    ['created_at', 'TEXT'],
    ['updated_at', 'TEXT'],
  ] as const) {
    requireColumn('review_jobs', name, type, true);
  }
  requireColumn('pull_request_state', 'repository', 'TEXT', false, 1);
  requireColumn('pull_request_state', 'pull_request_number', 'INTEGER', false, 2);
  requireColumn('review_findings', 'repository', 'TEXT', false, 1);
  requireColumn('review_findings', 'pull_request_number', 'INTEGER', false, 2);
  requireColumn('review_findings', 'fingerprint', 'TEXT', false, 3);
  requireColumn('review_findings', 'state', 'TEXT', true);
  for (const name of ['first_seen_job_id', 'last_seen_job_id'] as const) {
    requireColumn('review_findings', name, 'INTEGER', true);
  }
  requireColumn('command_audits', 'delivery_id', 'TEXT', false, 1);
  const uniqueIndexes = database.prepare('PRAGMA index_list(review_jobs)').all() as Array<{
    name: string;
    unique: number;
  }>;
  const hasIdentityUnique = uniqueIndexes.some(
    (index) =>
      index.unique === 1 &&
      (
        database.prepare(`PRAGMA index_info(${JSON.stringify(index.name)})`).all() as Array<{
          name: string;
        }>
      )
        .map((column) => column.name)
        .join('\0') === 'repository\0pull_request_number\0head_sha\0policy_version',
  );
  if (!hasIdentityUnique) {
    throw new Error('review_jobs identity unique constraint is missing');
  }

  const foreignKeys = (table: string) =>
    database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string;
      from: string;
    }>;

  if (
    !foreignKeys('review_jobs').some(
      (key) => key.table === 'webhook_deliveries' && key.from === 'delivery_id',
    )
  ) {
    throw new Error('review_jobs delivery foreign key is missing');
  }
  if (
    !foreignKeys('pull_request_state').some(
      (key) => key.table === 'review_jobs' && key.from === 'current_job_id',
    )
  ) {
    throw new Error('pull_request_state job foreign key is missing');
  }
  if (
    !foreignKeys('review_findings').some(
      (key) => key.table === 'review_jobs' && key.from === 'first_seen_job_id',
    ) ||
    !foreignKeys('review_findings').some(
      (key) => key.table === 'review_jobs' && key.from === 'last_seen_job_id',
    )
  ) {
    throw new Error('review_findings job foreign keys are missing');
  }
  const findingSql = String(
    (
      database
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='review_findings'")
        .get() as { sql: string }
    ).sql,
  ).toUpperCase();
  if (!findingSql.includes("STATE IN ('OPEN', 'STILL_PRESENT', 'FIXED')")) {
    throw new Error('review_findings state check constraint is missing');
  }
}

function addColumn(database: DatabaseSync, table: string, name: string, sqlType: string): void {
  if (!columns(database, table).has(name)) {
    database.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${sqlType}`);
  }
}

function assertBaselineCompatibility(database: DatabaseSync): void {
  const required: Record<string, readonly string[]> = {
    webhook_deliveries: ['delivery_id', 'received_at'],
    review_jobs: [
      'id',
      'repository',
      'pull_request_number',
      'head_sha',
      'policy_version',
      'installation_id',
      'action',
      'delivery_id',
      'state',
      'attempt',
      'created_at',
      'updated_at',
    ],
    pull_request_state: ['repository', 'pull_request_number', 'current_job_id', 'current_head_sha'],
    review_findings: [
      'repository',
      'pull_request_number',
      'fingerprint',
      'state',
      'first_seen_job_id',
      'last_seen_job_id',
    ],
    command_audits: ['delivery_id', 'repository', 'pull_request_number', 'comment_id', 'outcome'],
  };
  for (const [table, names] of Object.entries(required)) {
    const actual = columns(database, table);
    const missing = names.filter((name) => !actual.has(name));
    if (missing.length > 0) {
      throw new Error(`incompatible ${table} schema; missing ${missing.join(', ')}`);
    }
  }
}

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'baseline',
    apply: (database) => {
      database.exec(baselineTables);
      assertBaselineCompatibility(database);
      assertBaselineConstraints(database);
    },
  },
  {
    version: 2,
    name: 'review-facts-and-artifacts',
    apply: (database) => {
      addColumn(database, 'review_jobs', 'base_sha', 'TEXT');
      addColumn(database, 'review_jobs', 'pull_request_title', 'TEXT');
      addColumn(database, 'review_jobs', 'model', 'TEXT');
      addColumn(database, 'review_jobs', 'reasoning', 'TEXT');
      addColumn(database, 'review_jobs', 'prompt_version', 'TEXT');
      addColumn(database, 'review_jobs', 'prompt_hash', 'TEXT');
      addColumn(database, 'review_jobs', 'schema_version', 'TEXT');
      addColumn(database, 'review_jobs', 'schema_hash', 'TEXT');
      addColumn(database, 'review_jobs', 'review_started_at', 'TEXT');
      addColumn(database, 'review_jobs', 'review_completed_at', 'TEXT');
      addColumn(database, 'review_jobs', 'publication_started_at', 'TEXT');
      addColumn(database, 'review_jobs', 'published_at', 'TEXT');
      addColumn(database, 'review_jobs', 'superseded_by_job_id', 'INTEGER');
      addColumn(database, 'review_jobs', 'error_code', 'TEXT');
      addColumn(database, 'review_jobs', 'error_excerpt', 'TEXT');
      addColumn(database, 'review_jobs', 'artifact_hash', 'TEXT');
      database.exec(`
        CREATE TABLE IF NOT EXISTS artifact_snapshots (
          content_hash TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('prompt', 'review_schema')),
          content TEXT NOT NULL, byte_size INTEGER NOT NULL, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS review_artifacts (
          job_id INTEGER PRIMARY KEY REFERENCES review_jobs(id), schema_version TEXT,
          content_hash TEXT, result_json TEXT, created_at TEXT NOT NULL,
          availability TEXT NOT NULL DEFAULT 'AVAILABLE', unavailable_reason TEXT
        );
      `);
      addColumn(database, 'review_artifacts', 'availability', "TEXT NOT NULL DEFAULT 'AVAILABLE'");
      addColumn(database, 'review_artifacts', 'unavailable_reason', 'TEXT');
    },
  },
  {
    version: 3,
    name: 'evaluation-revisions',
    apply: (database) =>
      database.exec(`
      CREATE TABLE IF NOT EXISTS evaluation_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES review_jobs(id),
        target_type TEXT NOT NULL CHECK(target_type IN ('review', 'finding')),
        finding_fingerprint TEXT,
        verdict TEXT,
        rationale TEXT, source TEXT NOT NULL CHECK(source = 'manual'),
        action TEXT NOT NULL CHECK(action IN ('set', 'withdraw')),
        supersedes_id INTEGER REFERENCES evaluation_revisions(id), created_at TEXT NOT NULL,
        CHECK((action = 'withdraw' AND verdict IS NULL) OR (action = 'set' AND verdict IS NOT NULL)),
        CHECK((target_type = 'review' AND finding_fingerprint IS NULL) OR
              (target_type = 'finding' AND finding_fingerprint IS NOT NULL)),
        CHECK(action = 'withdraw' OR
              (target_type = 'review' AND verdict IN ('useful','mixed','not_useful','unable_to_assess')) OR
              (target_type = 'finding' AND verdict IN ('valid','partially_valid','false_positive','unable_to_verify'))),
        UNIQUE(job_id, target_type, finding_fingerprint, id)
      );
      CREATE INDEX IF NOT EXISTS evaluation_target_idx
        ON evaluation_revisions(job_id, target_type, finding_fingerprint, id DESC);
    `),
  },
  {
    version: 4,
    name: 'github-finding-threads',
    apply: (database) =>
      database.exec(`
      CREATE TABLE IF NOT EXISTS github_finding_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        fingerprint TEXT NOT NULL,
        publication_job_id INTEGER NOT NULL REFERENCES review_jobs(id),
        review_database_id TEXT NOT NULL,
        thread_node_id TEXT NOT NULL UNIQUE,
        comment_node_id TEXT NOT NULL,
        resolution_state TEXT NOT NULL DEFAULT 'OPEN'
          CHECK(resolution_state IN ('OPEN','RESOLUTION_PENDING','RESOLVED','RESOLUTION_FAILED')),
        resolved_by_job_id INTEGER REFERENCES review_jobs(id),
        resolved_head_sha TEXT,
        resolution_evidence TEXT,
        resolution_comment_node_id TEXT,
        resolution_attempts INTEGER NOT NULL DEFAULT 0,
        next_resolution_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE(publication_job_id, fingerprint)
      );
      CREATE INDEX IF NOT EXISTS github_finding_threads_target_idx
        ON github_finding_threads(repository, pull_request_number, fingerprint, id DESC);
      CREATE INDEX IF NOT EXISTS github_finding_threads_pending_idx
        ON github_finding_threads(resolution_state, next_resolution_at, id);
    `),
  },
  {
    version: 5,
    name: 'github-thread-association-queue',
    apply: (database) =>
      database.exec(`
      CREATE TABLE IF NOT EXISTS github_thread_association_intents (
        job_id INTEGER PRIMARY KEY REFERENCES review_jobs(id),
        repository TEXT NOT NULL,
        pull_request_number INTEGER NOT NULL,
        review_database_id TEXT NOT NULL,
        expected_fingerprints_json TEXT NOT NULL CHECK(json_valid(expected_fingerprints_json)),
        state TEXT NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','COMPLETED','FAILED')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS github_thread_association_pending_idx
        ON github_thread_association_intents(state, next_attempt_at, job_id);
    `),
  },
];

export function runMigrations(database: DatabaseSync): number {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
  );
  const ledgerRows = database
    .prepare('SELECT version,name FROM schema_migrations ORDER BY version')
    .all() as Array<{ version: number; name: string }>;
  const known = new Map(migrations.map((migration) => [migration.version, migration.name]));
  for (const entry of ledgerRows) {
    if (!known.has(Number(entry.version)) || known.get(Number(entry.version)) !== entry.name) {
      throw new Error(
        `unknown or mismatched schema migration ledger entry ${entry.version}:${entry.name}`,
      );
    }
  }
  const applied = new Set(ledgerRows.map((r) => Number(r.version)));
  const highestApplied = Math.max(0, ...applied);
  for (let version = 1; version <= highestApplied; version += 1) {
    if (!applied.has(version)) {
      throw new Error(`schema migration ledger gap at version ${version}`);
    }
  }
  let latest = 0;
  for (const migration of migrations) {
    if (applied.has(migration.version)) {
      latest = migration.version;
      continue;
    }
    if (migration.version !== latest + 1) {
      throw new Error(`schema migration gap before version ${migration.version}`);
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(database);
      database
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
      latest = migration.version;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
  assertBaselineCompatibility(database);
  assertBaselineConstraints(database);
  const finalVersion = schemaVersion(database);
  if (finalVersion !== migrations.length) {
    throw new Error(`schema migration incomplete at version ${finalVersion}`);
  }
  const observabilityColumns = columns(database, 'review_artifacts');
  if (
    !observabilityColumns.has('job_id') ||
    !observabilityColumns.has('content_hash') ||
    !observabilityColumns.has('availability')
  ) {
    throw new Error('incompatible review_artifacts schema');
  }
  const evaluationColumns = columns(database, 'evaluation_revisions');
  if (
    !evaluationColumns.has('target_type') ||
    !evaluationColumns.has('verdict') ||
    !evaluationColumns.has('action')
  ) {
    throw new Error('incompatible evaluation_revisions schema');
  }
  const threadColumns = columns(database, 'github_finding_threads');
  if (
    !threadColumns.has('thread_node_id') ||
    !threadColumns.has('resolution_state') ||
    !threadColumns.has('resolution_attempts')
  ) {
    throw new Error('incompatible github_finding_threads schema');
  }
  const associationColumns = columns(database, 'github_thread_association_intents');
  if (
    !associationColumns.has('expected_fingerprints_json') ||
    !associationColumns.has('state') ||
    !associationColumns.has('attempts')
  ) {
    throw new Error('incompatible github_thread_association_intents schema');
  }
  return latest;
}

export function schemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };
  return Number(row.version);
}
