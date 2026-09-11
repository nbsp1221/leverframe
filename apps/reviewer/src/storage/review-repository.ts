import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { type ReviewResult, findingFingerprint, reviewResultSchema } from '../review/result.js';
import { transaction } from './connection.js';

export interface ReviewJobReference {
  id: number;
  pullRequestNumber: number;
  repository: string;
}

export interface PreviousReview {
  headSha: string;
  resultPaths: string[];
  results?: ReviewResult[];
}

export interface ReviewArtifact {
  contentHash?: string;
  result?: ReviewResult;
  available: boolean;
  unavailableReason?: string;
}

export interface ReviewFinding {
  evidence: string;
  file: string;
  fingerprint: string;
  firstSeenJobId: number;
  lastSeenJobId: number;
  line: number;
  state: 'FIXED' | 'OPEN' | 'STILL_PRESENT';
  title: string;
}

export interface ReviewListQuery {
  page: number;
  sort?: 'created' | 'completed';
  query?: string;
  statuses?: readonly string[];
  evaluation?: 'evaluated' | 'needs_evaluation';
}

export interface ReviewMetrics {
  terminalWindowSize: number;
  terminalSampleSize: number;
  completedSampleSize: number;
  failedSampleSize: number;
  durationSampleSize: number;
  averageDurationMs?: number;
  medianDurationMs?: number;
  failureRate?: number;
}

export class ReviewRepository {
  constructor(
    private readonly database: DatabaseSync,
    private readonly dataRoot: string,
  ) {}

  findPreviousCompletedReview(job: ReviewJobReference): PreviousReview | undefined {
    const row = this.database
      .prepare(`
        SELECT id, head_sha
        FROM review_jobs
        WHERE repository = ?
          AND pull_request_number = ?
          AND id < ?
          AND state = 'DONE'
        ORDER BY id DESC
        LIMIT 1
      `)
      .get(job.repository, job.pullRequestNumber, job.id) as Record<string, unknown> | undefined;

    if (row === undefined) {
      return undefined;
    }

    const resultPaths = this.database
      .prepare(`
        SELECT id, result_path
        FROM review_jobs
        WHERE repository = ?
          AND pull_request_number = ?
          AND id < ?
          AND state = 'DONE'
        ORDER BY id DESC
        LIMIT 20
      `)
      .all(job.repository, job.pullRequestNumber, job.id) as Array<{
      id: number;
      result_path: string | null;
    }>;
    const newestPath = resultPaths.find(
      (candidate) => Number(candidate.id) === Number(row.id),
    )?.result_path;
    const dualReadPaths =
      newestPath === null || newestPath === undefined
        ? []
        : resultPaths
            .filter((result) => result.result_path !== null)
            .map((result) => String(result.result_path));
    const newestArtifact = this.getReviewArtifact(Number(row.id));
    const artifactIds =
      newestArtifact?.available === true
        ? (
            this.database
              .prepare(
                `SELECT id FROM review_jobs WHERE repository=? AND pull_request_number=? AND id<? AND state='DONE' ORDER BY id DESC LIMIT 20`,
              )
              .all(job.repository, job.pullRequestNumber, job.id) as Array<{ id: number }>
          )
            .map((candidate) => this.getReviewArtifact(Number(candidate.id))?.result)
            .filter((candidate): candidate is ReviewResult => candidate !== undefined)
        : [];

    return {
      headSha: String(row.head_sha),
      resultPaths: dualReadPaths,
      ...(newestArtifact?.available === true && artifactIds.length > 0
        ? { results: artifactIds }
        : {}),
    };
  }

  reconcileFindings(input: {
    job: ReviewJobReference;
    previousResult: ReviewResult | undefined;
    result: ReviewResult;
  }): void {
    const now = new Date().toISOString();
    const upsertFinding = this.database.prepare(`
      INSERT INTO review_findings (
        repository, pull_request_number, fingerprint, file, line, title,
        evidence, state, first_seen_job_id, last_seen_job_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
      ON CONFLICT(repository, pull_request_number, fingerprint) DO UPDATE SET
        file = excluded.file,
        line = excluded.line,
        title = excluded.title,
        evidence = excluded.evidence,
        state = 'OPEN',
        last_seen_job_id = excluded.last_seen_job_id,
        updated_at = excluded.updated_at
    `);
    const seedFinding = this.database.prepare(`
      INSERT OR IGNORE INTO review_findings (
        repository, pull_request_number, fingerprint, file, line, title,
        evidence, state, first_seen_job_id, last_seen_job_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', ?, ?, ?, ?)
    `);
    const updateFinding = this.database.prepare(`
      UPDATE review_findings
      SET state = ?, evidence = ?, last_seen_job_id = ?, updated_at = ?
      WHERE repository = ? AND pull_request_number = ? AND fingerprint = ?
    `);

    transaction(this.database, () => {
      for (const finding of input.previousResult?.findings ?? []) {
        seedFinding.run(
          input.job.repository,
          input.job.pullRequestNumber,
          findingFingerprint(finding),
          finding.file,
          finding.line,
          finding.title,
          finding.evidence,
          input.job.id,
          input.job.id,
          now,
          now,
        );
      }
      for (const finding of input.result.findings) {
        upsertFinding.run(
          input.job.repository,
          input.job.pullRequestNumber,
          findingFingerprint(finding),
          finding.file,
          finding.line,
          finding.title,
          finding.evidence,
          input.job.id,
          input.job.id,
          now,
          now,
        );
      }
      for (const update of input.result.finding_updates ?? []) {
        updateFinding.run(
          update.status === 'fixed' ? 'FIXED' : 'STILL_PRESENT',
          update.evidence,
          input.job.id,
          now,
          input.job.repository,
          input.job.pullRequestNumber,
          update.fingerprint,
        );
      }
    });
  }

  listReviewJobs(input: ReviewListQuery): {
    items: Array<Record<string, unknown>>;
    totalItems: number;
  } {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (input.query !== undefined && input.query.trim() !== '') {
      const query = `%${input.query.trim().toLowerCase()}%`;
      where.push(
        "(lower(repository) LIKE ? OR lower(COALESCE(pull_request_title, '')) LIKE ? OR CAST(pull_request_number AS TEXT) LIKE ?)",
      );
      params.push(query, query, query);
    }
    if (input.statuses !== undefined && input.statuses.length > 0) {
      where.push(`state IN (${input.statuses.map(() => '?').join(',')})`);
      params.push(...input.statuses);
    }
    if (input.evaluation === 'evaluated') {
      where.push(
        "EXISTS (SELECT 1 FROM evaluation_revisions e WHERE e.job_id=j.id AND e.target_type='review' AND e.action='set' AND e.id=(SELECT MAX(id) FROM evaluation_revisions WHERE job_id=j.id AND target_type='review'))",
      );
    } else if (input.evaluation === 'needs_evaluation') {
      where.push(
        "j.state='DONE' AND EXISTS (SELECT 1 FROM review_artifacts available_artifact WHERE available_artifact.job_id=j.id AND available_artifact.availability='AVAILABLE' AND json_valid(available_artifact.result_json) AND sha256(available_artifact.result_json)=available_artifact.content_hash AND sha256(available_artifact.result_json)=j.artifact_hash) AND NOT EXISTS (SELECT 1 FROM evaluation_revisions e WHERE e.job_id=j.id AND e.target_type='review' AND e.action='set' AND e.id=(SELECT MAX(id) FROM evaluation_revisions WHERE job_id=j.id AND target_type='review'))",
      );
    }
    const predicate = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const count = this.database
      .prepare(`SELECT COUNT(*) AS count FROM review_jobs j ${predicate}`)
      .get(...params) as { count: number };
    const orderBy =
      input.sort === 'completed'
        ? 'j.review_completed_at DESC, j.id DESC'
        : 'j.created_at DESC, j.id DESC';
    const rows = this.database
      .prepare(`
      SELECT j.*, a.availability, a.result_json,
        (SELECT COUNT(*) FROM json_each(CASE WHEN a.availability='AVAILABLE' AND json_valid(a.result_json) AND sha256(a.result_json)=a.content_hash AND sha256(a.result_json)=j.artifact_hash THEN json_extract(a.result_json,'$.findings') ELSE '[]' END)) AS findings_count,
        (SELECT COUNT(*) FROM evaluation_revisions e WHERE e.job_id=j.id AND e.target_type='finding' AND e.action='set' AND e.id=(SELECT MAX(id) FROM evaluation_revisions WHERE job_id=j.id AND target_type='finding' AND finding_fingerprint=e.finding_fingerprint)) AS evaluated_findings,
        (SELECT MAX(id) FROM evaluation_revisions e WHERE e.job_id=j.id AND e.target_type='review') AS review_evaluation_id,
        (SELECT verdict FROM evaluation_revisions e WHERE e.id=(SELECT MAX(id) FROM evaluation_revisions WHERE job_id=j.id AND target_type='review')) AS review_verdict
      FROM review_jobs j LEFT JOIN review_artifacts a ON a.job_id=j.id ${predicate}
      ORDER BY ${orderBy} LIMIT 20 OFFSET ?
    `)
      .all(...params, (Math.max(1, input.page) - 1) * 20) as Array<Record<string, unknown>>;
    return { totalItems: Number(count.count), items: rows };
  }

  getReviewMetrics(terminalWindowSize = 50): ReviewMetrics {
    const limit = Math.max(1, Math.floor(terminalWindowSize));
    const rows = this.database
      .prepare(`
        SELECT state, review_started_at, review_completed_at
        FROM review_jobs
        WHERE state IN ('DONE', 'FAILED', 'TIMED_OUT')
        ORDER BY id DESC
        LIMIT ?
      `)
      .all(limit) as Array<Record<string, unknown>>;

    const completed = rows.filter((row) => row.state === 'DONE');
    const failed = rows.length - completed.length;
    const durations = completed
      .map((row) => reviewDurationMilliseconds(row.review_started_at, row.review_completed_at))
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    const averageDurationMs =
      durations.length === 0
        ? undefined
        : durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
    const medianDurationMs = median(durations);

    return {
      terminalWindowSize: limit,
      terminalSampleSize: rows.length,
      completedSampleSize: completed.length,
      failedSampleSize: failed,
      durationSampleSize: durations.length,
      ...(averageDurationMs === undefined ? {} : { averageDurationMs }),
      ...(medianDurationMs === undefined ? {} : { medianDurationMs }),
      ...(rows.length === 0 ? {} : { failureRate: failed / rows.length }),
    };
  }

  getReviewJobRow(id: number): Record<string, unknown> | undefined {
    return this.database.prepare('SELECT * FROM review_jobs WHERE id=?').get(id);
  }

  getReviewFindings(repository: string, pullRequestNumber: number): ReviewFinding[] {
    const rows = this.database
      .prepare(`
        SELECT * FROM review_findings
        WHERE repository = ? AND pull_request_number = ?
        ORDER BY first_seen_job_id, fingerprint
      `)
      .all(repository, pullRequestNumber) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      evidence: String(row.evidence),
      file: String(row.file),
      fingerprint: String(row.fingerprint),
      firstSeenJobId: Number(row.first_seen_job_id),
      lastSeenJobId: Number(row.last_seen_job_id),
      line: Number(row.line),
      state: String(row.state) as ReviewFinding['state'],
      title: String(row.title),
    }));
  }

  recordReviewMetadata(input: {
    jobId: number;
    baseSha?: string;
    pullRequestTitle?: string;
    model?: string;
    reasoning?: string;
    promptVersion?: string;
    prompt?: string;
    schemaVersion?: string;
    schema?: string;
  }): void {
    const now = new Date().toISOString();
    transaction(this.database, () => {
      this.database
        .prepare(
          `UPDATE review_jobs SET base_sha=COALESCE(?,base_sha), pull_request_title=COALESCE(?,pull_request_title), model=COALESCE(?,model), reasoning=COALESCE(?,reasoning), prompt_version=COALESCE(?,prompt_version), prompt_hash=COALESCE(?,prompt_hash), schema_version=COALESCE(?,schema_version), schema_hash=COALESCE(?,schema_hash) WHERE id=?`,
        )
        .run(
          input.baseSha ?? null,
          input.pullRequestTitle ?? null,
          input.model ?? null,
          input.reasoning ?? null,
          input.promptVersion ?? null,
          input.prompt === undefined ? null : hashContent(input.prompt),
          input.schemaVersion ?? null,
          input.schema === undefined ? null : hashContent(input.schema),
          input.jobId,
        );
      for (const snapshot of [
        { kind: 'prompt', content: input.prompt },
        { kind: 'review_schema', content: input.schema },
      ] as const) {
        if (snapshot.content !== undefined) {
          this.database
            .prepare(
              `INSERT OR IGNORE INTO artifact_snapshots(content_hash,kind,content,byte_size,created_at) VALUES (?,?,?,?,?)`,
            )
            .run(
              hashContent(snapshot.content),
              snapshot.kind,
              snapshot.content,
              Buffer.byteLength(snapshot.content),
              now,
            );
        }
      }
    });
  }

  recordReviewArtifact(jobId: number, result: ReviewResult, schemaVersion?: string): string {
    const parsedResult = reviewResultSchema.parse(result);
    const resultJson = JSON.stringify(parsedResult);
    const contentHash = hashContent(resultJson);
    const now = new Date().toISOString();
    transaction(this.database, () => {
      this.database
        .prepare(
          `INSERT INTO review_artifacts(job_id,schema_version,content_hash,result_json,created_at,availability,unavailable_reason) VALUES (?,?,?,?,?,'AVAILABLE',NULL) ON CONFLICT(job_id) DO UPDATE SET schema_version=excluded.schema_version,content_hash=excluded.content_hash,result_json=excluded.result_json,availability='AVAILABLE',unavailable_reason=NULL`,
        )
        .run(jobId, schemaVersion ?? null, contentHash, resultJson, now);
      this.database
        .prepare('UPDATE review_jobs SET artifact_hash=?, updated_at=? WHERE id=?')
        .run(contentHash, now, jobId);
    });
    return contentHash;
  }

  getReviewArtifact(jobId: number): ReviewArtifact | undefined {
    const row = this.database
      .prepare(
        'SELECT artifacts.content_hash,artifacts.result_json,artifacts.availability,artifacts.unavailable_reason,jobs.artifact_hash FROM review_artifacts AS artifacts JOIN review_jobs AS jobs ON jobs.id=artifacts.job_id WHERE artifacts.job_id=?',
      )
      .get(jobId) as Record<string, unknown> | undefined;
    if (row === undefined) {
      return undefined;
    }
    if (row.availability !== 'AVAILABLE' || typeof row.result_json !== 'string') {
      return {
        available: false,
        ...(typeof row.unavailable_reason === 'string'
          ? { unavailableReason: row.unavailable_reason }
          : {}),
      };
    }
    try {
      const actualHash = hashContent(row.result_json);
      if (
        typeof row.content_hash !== 'string' ||
        actualHash !== row.content_hash ||
        typeof row.artifact_hash !== 'string' ||
        actualHash !== row.artifact_hash
      ) {
        return { available: false, unavailableReason: 'CORRUPT_HASH' };
      }
      return {
        available: true,
        ...(typeof row.content_hash === 'string' ? { contentHash: row.content_hash } : {}),
        result: reviewResultSchema.parse(JSON.parse(row.result_json)),
      };
    } catch {
      return { available: false, unavailableReason: 'CORRUPT_JSON' };
    }
  }

  backfillArtifacts(): void {
    const rows = this.database
      .prepare(
        `SELECT id,result_path FROM review_jobs WHERE state='DONE' AND result_path IS NOT NULL AND NOT EXISTS (SELECT 1 FROM review_artifacts WHERE job_id=review_jobs.id)`,
      )
      .all() as Array<{ id: number; result_path: string }>;
    for (const row of rows) {
      const root = canonicalPath(this.dataRoot);
      const configuredPath = resolve(this.dataRoot, String(row.result_path));
      const path = canonicalPath(configuredPath);
      const inside = isWithin(root, path);
      let reason: string | undefined;
      let result: ReviewResult | undefined;
      if (!inside) {
        reason = 'OUT_OF_ROOT';
      } else if (!existsSync(path)) {
        reason = 'MISSING';
      } else {
        try {
          const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
          result = reviewResultSchema.parse(parsed);
        } catch (error) {
          if (reason === undefined) {
            reason = error instanceof SyntaxError ? 'CORRUPT_JSON' : 'INVALID_RESULT';
          }
        }
      }
      if (result !== undefined) {
        this.recordReviewArtifact(Number(row.id), result);
      } else {
        transaction(this.database, () =>
          this.database
            .prepare(
              `INSERT INTO review_artifacts(job_id,created_at,availability,unavailable_reason) VALUES (?,?,?,?)`,
            )
            .run(Number(row.id), new Date().toISOString(), 'UNAVAILABLE', reason ?? 'UNAVAILABLE'),
        );
      }
    }
  }
}

function canonicalPath(path: string, requireExists = true): string {
  if (requireExists && existsSync(path)) {
    return realpathSync(path);
  }
  return resolve(path);
}

function isWithin(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === '' || (relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function reviewDurationMilliseconds(start: unknown, end: unknown): number | undefined {
  if (typeof start !== 'string' || typeof end !== 'string') {
    return undefined;
  }
  const value = Date.parse(end) - Date.parse(start);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function median(values: readonly number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  const middle = Math.floor(values.length / 2);
  if (values.length % 2 === 1) {
    return values[middle];
  }
  return (values[middle - 1]! + values[middle]!) / 2;
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
