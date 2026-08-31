import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  version: number;
  name: string;
  apply: (database: DatabaseSync) => void;
  requiresForeignKeysDisabled?: boolean;
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

function assertBaselineConstraints(database: DatabaseSync, requireIdentityUnique: boolean): void {
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
  if (requireIdentityUnique && !hasIdentityUnique) {
    throw new Error('review_jobs identity unique constraint is missing');
  }
  if (!requireIdentityUnique && hasIdentityUnique) {
    throw new Error('review_jobs still reuses logical review identities');
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
      assertBaselineConstraints(database, true);
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
  {
    version: 6,
    name: 'immutable-review-job-executions',
    requiresForeignKeysDisabled: true,
    apply: (database) =>
      database.exec(`
      CREATE TABLE review_jobs_v6 (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL, policy_version TEXT NOT NULL, installation_id INTEGER NOT NULL,
        action TEXT NOT NULL, delivery_id TEXT NOT NULL REFERENCES webhook_deliveries(delivery_id),
        state TEXT NOT NULL DEFAULT 'QUEUED', attempt INTEGER NOT NULL DEFAULT 0, error TEXT,
        check_run_id INTEGER, result_path TEXT, published_review_id INTEGER,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        base_sha TEXT, pull_request_title TEXT, model TEXT, reasoning TEXT,
        prompt_version TEXT, prompt_hash TEXT, schema_version TEXT, schema_hash TEXT,
        review_started_at TEXT, review_completed_at TEXT, publication_started_at TEXT,
        published_at TEXT, superseded_by_job_id INTEGER, error_code TEXT,
        error_excerpt TEXT, artifact_hash TEXT
      );
      INSERT INTO review_jobs_v6 (
        id, repository, pull_request_number, head_sha, policy_version, installation_id,
        action, delivery_id, state, attempt, error, check_run_id, result_path,
        published_review_id, created_at, updated_at, base_sha, pull_request_title,
        model, reasoning, prompt_version, prompt_hash, schema_version, schema_hash,
        review_started_at, review_completed_at, publication_started_at, published_at,
        superseded_by_job_id, error_code, error_excerpt, artifact_hash
      )
      SELECT
        id, repository, pull_request_number, head_sha, policy_version, installation_id,
        action, delivery_id, state, attempt, error, check_run_id, result_path,
        published_review_id, created_at, updated_at, base_sha, pull_request_title,
        model, reasoning, prompt_version, prompt_hash, schema_version, schema_hash,
        review_started_at, review_completed_at, publication_started_at, published_at,
        superseded_by_job_id, error_code, error_excerpt, artifact_hash
      FROM review_jobs;
      DROP TABLE review_jobs;
      ALTER TABLE review_jobs_v6 RENAME TO review_jobs;
    `),
  },
  {
    version: 7,
    name: 'leverframe-development-runs',
    apply: (database) =>
      database.exec(`
      CREATE TABLE development_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        workflow_key TEXT NOT NULL DEFAULT 'development' CHECK(workflow_key = 'development'),
        workflow_version TEXT NOT NULL DEFAULT 'development-v1' CHECK(workflow_version = 'development-v1'),
        repository TEXT NOT NULL CHECK(length(repository) BETWEEN 3 AND 255),
        accepted_work_revision_id INTEGER REFERENCES development_work_revisions(id),
        phase TEXT NOT NULL CHECK(phase IN (
          'INTAKE','PREPARING','PLANNING','AWAITING_PLAN_APPROVAL','IMPLEMENTING','VERIFYING',
          'AWAITING_PUBLICATION_APPROVAL','PUBLISHING','REVIEWING','AWAITING_MERGE',
          'WAITING_FOR_INPUT','COMPLETED','FAILED','CANCELLED'
        )),
        prior_phase TEXT CHECK(prior_phase IS NULL OR prior_phase IN (
          'INTAKE','PREPARING','PLANNING','AWAITING_PLAN_APPROVAL','IMPLEMENTING','VERIFYING',
          'AWAITING_PUBLICATION_APPROVAL','PUBLISHING','REVIEWING','AWAITING_MERGE'
        )),
        generation INTEGER NOT NULL DEFAULT 1 CHECK(generation > 0),
        lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version > 0),
        candidate_hash TEXT CHECK(candidate_hash IS NULL OR (
          length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'
        )),
        last_activity_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX development_runs_phase_activity_idx
        ON development_runs(phase, last_activity_at DESC, id DESC);

      CREATE TABLE development_work_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL CHECK(revision > 0),
        source_kind TEXT NOT NULL CHECK(source_kind IN ('WEB','TICKET')),
        goal TEXT NOT NULL CHECK(length(goal) BETWEEN 1 AND 20000),
        normalized_json TEXT NOT NULL CHECK(json_valid(normalized_json)),
        source_provider TEXT,
        source_external_id TEXT,
        source_external_key TEXT,
        source_url TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, revision),
        CHECK((source_kind = 'WEB' AND source_provider IS NULL AND source_external_id IS NULL) OR
              (source_kind = 'TICKET' AND source_provider IS NOT NULL AND source_external_id IS NOT NULL))
      );
      CREATE INDEX development_work_revisions_run_idx
        ON development_work_revisions(run_id, revision DESC);

      CREATE TABLE development_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        work_revision_id INTEGER NOT NULL REFERENCES development_work_revisions(id),
        phase TEXT NOT NULL CHECK(phase IN ('PREPARING','PLANNING','IMPLEMENTING','VERIFYING','PUBLISHING','REVIEWING')),
        attempt INTEGER NOT NULL CHECK(attempt > 0),
        generation INTEGER NOT NULL CHECK(generation > 0),
        executor_kind TEXT NOT NULL CHECK(executor_kind IN ('CODEX_APP_SERVER','DETERMINISTIC','REVIEWER')),
        codex_profile TEXT,
        thread_id TEXT,
        turn_id TEXT,
        state TEXT NOT NULL CHECK(state IN ('CLAIMED','RUNNING','WAITING','SUCCEEDED','FAILED','CANCELLED','LOST')),
        lease_owner TEXT,
        lease_expires_at TEXT,
        candidate_hash TEXT CHECK(candidate_hash IS NULL OR (
          length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'
        )),
        outcome_code TEXT,
        outcome_excerpt TEXT CHECK(outcome_excerpt IS NULL OR length(outcome_excerpt) <= 4000),
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, phase, attempt),
        UNIQUE(run_id, generation),
        CHECK((state IN ('CLAIMED','RUNNING','WAITING') AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL) OR
              (state IN ('SUCCEEDED','FAILED','CANCELLED','LOST')))
      );
      CREATE UNIQUE INDEX development_attempts_one_active_run_idx
        ON development_attempts(run_id) WHERE state IN ('CLAIMED','RUNNING','WAITING');
      CREATE INDEX development_attempts_lease_idx
        ON development_attempts(state, lease_expires_at);

      CREATE TABLE development_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        generation INTEGER NOT NULL CHECK(generation > 0),
        attempt_id INTEGER REFERENCES development_attempts(id) ON DELETE SET NULL,
        type TEXT NOT NULL CHECK(length(type) BETWEEN 1 AND 120),
        source TEXT NOT NULL CHECK(source IN ('LEVERFRAME','CODEX','SANDBOX','GITHUB','TICKET','HUMAN')),
        trust TEXT NOT NULL CHECK(trust IN ('SYSTEM_OBSERVED','HARNESS_OBSERVED','AGENT_CLAIMED','HUMAN_DECIDED')),
        idempotency_key TEXT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json) <= 65536),
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(run_id, sequence)
      );
      CREATE UNIQUE INDEX development_events_idempotency_idx
        ON development_events(run_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
      CREATE INDEX development_events_run_idx ON development_events(run_id, sequence);

      CREATE TABLE development_interrupts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        work_revision_id INTEGER NOT NULL REFERENCES development_work_revisions(id),
        attempt_id INTEGER REFERENCES development_attempts(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        kind TEXT NOT NULL CHECK(kind IN ('CLARIFICATION','PLAN_APPROVAL','PUBLICATION_APPROVAL')),
        status TEXT NOT NULL CHECK(status IN ('OPEN','ANSWERED','APPROVED','REJECTED','CANCELLED','SUPERSEDED')),
        request_id TEXT,
        thread_id TEXT,
        turn_id TEXT,
        prompt TEXT NOT NULL CHECK(length(prompt) BETWEEN 1 AND 20000),
        context_json TEXT NOT NULL CHECK(json_valid(context_json) AND length(context_json) <= 65536),
        candidate_hash TEXT CHECK(candidate_hash IS NULL OR (
          length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'
        )),
        publication_kind TEXT CHECK(publication_kind IS NULL OR publication_kind IN ('PUSH_AND_PR','PUSH_EXISTING')),
        response TEXT CHECK(response IS NULL OR length(response) <= 20000),
        lock_version INTEGER NOT NULL DEFAULT 1 CHECK(lock_version > 0),
        requested_at TEXT NOT NULL,
        resolved_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK((kind = 'PUBLICATION_APPROVAL' AND candidate_hash IS NOT NULL AND publication_kind IS NOT NULL) OR
              (kind != 'PUBLICATION_APPROVAL' AND publication_kind IS NULL))
      );
      CREATE UNIQUE INDEX development_interrupts_one_open_run_idx
        ON development_interrupts(run_id) WHERE status = 'OPEN';
      CREATE INDEX development_interrupts_run_idx ON development_interrupts(run_id, id);

      CREATE TABLE development_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        work_revision_id INTEGER NOT NULL REFERENCES development_work_revisions(id),
        attempt_id INTEGER REFERENCES development_attempts(id) ON DELETE SET NULL,
        generation INTEGER NOT NULL CHECK(generation > 0),
        candidate_hash TEXT NOT NULL CHECK(
          length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'
        ),
        criterion TEXT NOT NULL CHECK(length(criterion) BETWEEN 1 AND 1000),
        method TEXT NOT NULL CHECK(method IN ('COMMAND','BROWSER','INSPECTION','EXTERNAL_OBSERVATION')),
        observation TEXT NOT NULL CHECK(length(observation) BETWEEN 1 AND 10000),
        command_or_artifact TEXT CHECK(command_or_artifact IS NULL OR length(command_or_artifact) <= 4000),
        result_code TEXT,
        trust TEXT NOT NULL CHECK(trust IN ('SYSTEM_OBSERVED','HARNESS_OBSERVED','AGENT_CLAIMED','HUMAN_DECIDED')),
        excerpt TEXT CHECK(excerpt IS NULL OR length(excerpt) <= 4000),
        verdict TEXT NOT NULL CHECK(verdict IN ('PASSED','FAILED','UNRESOLVED')),
        created_at TEXT NOT NULL,
        CHECK(NOT (trust = 'AGENT_CLAIMED' AND verdict = 'PASSED'))
      );
      CREATE INDEX development_evidence_candidate_idx
        ON development_evidence(run_id, candidate_hash, id);

      CREATE TABLE development_external_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
        kind TEXT NOT NULL CHECK(kind IN ('TICKET','PULL_REQUEST')),
        external_id TEXT NOT NULL CHECK(length(external_id) BETWEEN 1 AND 255),
        external_key TEXT,
        url TEXT,
        observation_json TEXT CHECK(observation_json IS NULL OR json_valid(observation_json)),
        observed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, provider, kind)
      );
      CREATE INDEX development_external_refs_run_idx ON development_external_refs(run_id, id);

      CREATE TABLE development_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('SANDBOX','WORKSPACE','BRANCH','PREVIEW')),
        provider TEXT NOT NULL,
        external_id TEXT NOT NULL,
        locator TEXT,
        state TEXT NOT NULL CHECK(state IN ('PROVISIONING','ACTIVE','STOPPED','RETAINED','CLEANUP_PENDING','CLEANUP_FAILED','CLEANED','UNKNOWN')),
        generation INTEGER NOT NULL CHECK(generation > 0),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 4000),
        observed_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(run_id, kind)
      );
      CREATE INDEX development_resources_state_idx ON development_resources(state, updated_at);

      CREATE TABLE development_outbound_intents (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES development_runs(id) ON DELETE CASCADE,
        provider TEXT NOT NULL CHECK(length(provider) BETWEEN 1 AND 80),
        operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 120),
        idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 255),
        state TEXT NOT NULL CHECK(state IN ('PENDING','PERFORMING','UNKNOWN','CONFIRMED','FAILED','CANCELLED')),
        candidate_hash TEXT CHECK(candidate_hash IS NULL OR (
          length(candidate_hash) = 64 AND candidate_hash NOT GLOB '*[^0-9a-f]*'
        )),
        request_json TEXT NOT NULL CHECK(json_valid(request_json) AND length(request_json) <= 65536),
        observation_json TEXT CHECK(observation_json IS NULL OR json_valid(observation_json)),
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
        last_error TEXT CHECK(last_error IS NULL OR length(last_error) <= 4000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(provider, idempotency_key)
      );
      CREATE INDEX development_outbound_intents_state_idx
        ON development_outbound_intents(state, updated_at);
    `),
  },
  {
    version: 8,
    name: 'close-terminal-development-interrupts',
    apply: (database) => {
      const now = new Date().toISOString();
      database
        .prepare(`
          UPDATE development_interrupts SET
            status = 'CANCELLED', resolved_at = ?, updated_at = ?, lock_version = lock_version + 1
          WHERE status = 'OPEN' AND run_id IN (
            SELECT id FROM development_runs WHERE phase IN ('COMPLETED', 'FAILED', 'CANCELLED')
          )
        `)
        .run(now, now);
    },
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
    if (migration.requiresForeignKeysDisabled === true) {
      database.exec('PRAGMA foreign_keys = OFF');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      migration.apply(database);
      if (migration.requiresForeignKeysDisabled === true) {
        const violations = database.prepare('PRAGMA foreign_key_check').all();
        if (violations.length > 0) {
          throw new Error(`schema migration ${migration.version} created foreign key violations`);
        }
      }
      database
        .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, new Date().toISOString());
      database.exec('COMMIT');
      if (migration.requiresForeignKeysDisabled === true) {
        database.exec('PRAGMA foreign_keys = ON');
      }
      latest = migration.version;
    } catch (error) {
      if (database.isTransaction) {
        database.exec('ROLLBACK');
      }
      if (migration.requiresForeignKeysDisabled === true) {
        database.exec('PRAGMA foreign_keys = ON');
      }
      throw error;
    }
  }
  assertBaselineCompatibility(database);
  assertBaselineConstraints(database, false);
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
  for (const [table, requiredColumns] of Object.entries({
    development_runs: ['accepted_work_revision_id', 'phase', 'generation', 'lock_version'],
    development_work_revisions: ['run_id', 'revision', 'source_kind', 'goal'],
    development_attempts: ['run_id', 'work_revision_id', 'generation', 'state'],
    development_events: ['run_id', 'sequence', 'generation', 'trust', 'payload_json'],
    development_interrupts: ['run_id', 'work_revision_id', 'generation', 'lock_version'],
    development_evidence: ['run_id', 'candidate_hash', 'trust', 'verdict'],
    development_external_refs: ['run_id', 'provider', 'kind', 'external_id'],
    development_resources: ['run_id', 'kind', 'state', 'generation'],
    development_outbound_intents: ['run_id', 'provider', 'idempotency_key', 'state'],
  })) {
    const actual = columns(database, table);
    if (requiredColumns.some((column) => !actual.has(column))) {
      throw new Error(`incompatible ${table} schema`);
    }
  }
  return latest;
}

export function schemaVersion(database: DatabaseSync): number {
  const row = database
    .prepare('SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations')
    .get() as { version: number };
  return Number(row.version);
}
