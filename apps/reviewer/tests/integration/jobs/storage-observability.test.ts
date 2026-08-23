import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import type { ReviewResult } from '../../../src/review/result.js';
import { EvaluationConflictError, JobDatabase } from '../../../src/jobs/database.js';
import { selectReviewContext } from '../../../src/review/history.js';
import { FAILURE_EXCERPT_MAX_BYTES, redactFailureExcerpt } from '../../../src/storage/failure.js';
import { migrations } from '../../../src/storage/migrations/index.js';

const input = {
  action: 'opened',
  deliveryId: 'd1',
  headSha: 'a'.repeat(40),
  installationId: 1,
  policyVersion: 'v1',
  pullRequestNumber: 1,
  repository: 'o/r',
};
const result: ReviewResult = {
  findings: [
    {
      confidence: 'high',
      evidence: 'e',
      explanation: 'x',
      file: 'src/a.ts',
      line: 2,
      severity: 'high',
      suggested_action: 'fix',
      title: 'Bug',
    },
  ],
  limitations: [],
  summary: 's',
  tests_run: [],
};

describe('review observability storage', () => {
  it('preserves cancelled execution facts when creating a replacement execution', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(input);
    const job = database.claimNextJob();
    if (job === undefined) {
      throw new Error('expected a claimed job');
    }
    database.recordReviewMetadata({
      baseSha: 'b'.repeat(40),
      jobId: job.id,
      model: 'old-model',
      prompt: 'old prompt',
      pullRequestTitle: 'Old title',
      reasoning: 'low',
      schema: '{}',
    });
    database.updateJob({
      attempt: job.attempt ?? 0,
      checkRunId: 10,
      expectedStates: ['CHECKING_OUT'],
      id: job.id,
      state: 'REVIEWING',
    });
    database.updateJob({
      attempt: job.attempt ?? 0,
      expectedStates: ['REVIEWING'],
      id: job.id,
      resultPath: '/old/result.json',
      state: 'VALIDATING',
    });
    database.recordReviewArtifact(job.id, result);
    database.updateJob({
      attempt: job.attempt ?? 0,
      expectedStates: ['VALIDATING'],
      id: job.id,
      state: 'PUBLISHING',
    });
    expect(
      database.cancelPullRequest({
        action: 'converted_to_draft',
        deliveryId: 'cancelled',
        headSha: input.headSha,
        installationId: input.installationId,
        pullRequestNumber: input.pullRequestNumber,
        repository: input.repository,
      }),
    ).toMatchObject({ jobsCancelled: 1 });
    expect(database.getReviewArtifact(job.id)?.available).toBe(true);

    expect(
      database.enqueuePullRequest({
        ...input,
        action: 'ready_for_review',
        deliveryId: 'revived',
      }),
    ).toMatchObject({ jobCreated: true });
    expect(database.getReviewArtifact(job.id)?.available).toBe(true);
    const cancelled = database.getReviewJob(job.id);
    expect(cancelled).toMatchObject({
      action: 'opened',
      state: 'CANCELLED',
    });
    expect(cancelled?.artifactHash).toBeDefined();
    expect(cancelled?.checkRunId).toBe(10);
    expect(cancelled?.model).toBe('old-model');
    expect(cancelled?.pullRequestTitle).toBe('Old title');
    expect(cancelled?.resultPath).toBe('/old/result.json');

    const replacement = database.claimNextJob();
    if (replacement === undefined) {
      throw new Error('expected a replacement execution');
    }
    expect(replacement.id).toBeGreaterThan(job.id);
    expect(database.getReviewArtifact(replacement.id)).toBeUndefined();
    expect(replacement).toMatchObject({ action: 'ready_for_review', state: 'CHECKING_OUT' });
    expect(replacement.artifactHash).toBeUndefined();
    expect(replacement.checkRunId).toBeUndefined();
    expect(replacement.model).toBeUndefined();
    expect(replacement.pullRequestTitle).toBeUndefined();
    expect(replacement.resultPath).toBeUndefined();
    database.close();
  });

  it('migrates a legacy database idempotently and rolls back incompatible baseline detection', () => {
    const root = mkdtempSync('/tmp/leverframe-migration-');
    try {
      const path = join(root, 'legacy.sqlite');
      const legacy = new DatabaseSync(path);
      legacy.exec(
        'PRAGMA foreign_keys = ON; CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)',
      );
      for (const migration of migrations.slice(0, 5)) {
        legacy.exec('BEGIN IMMEDIATE');
        migration.apply(legacy);
        legacy
          .prepare('INSERT INTO schema_migrations(version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        legacy.exec('COMMIT');
      }
      legacy.exec(
        `INSERT INTO webhook_deliveries(delivery_id,received_at) VALUES('d1','2026-08-24T00:00:00.000Z')`,
      );
      legacy
        .prepare(
          `INSERT INTO review_jobs(repository,pull_request_number,head_sha,policy_version,installation_id,action,delivery_id,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'CANCELLED',?,?)`,
        )
        .run('o/r', 1, 'a'.repeat(40), 'v1', 1, 'opened', 'd1', 'now', 'now');
      legacy.close();
      const migrated = new JobDatabase(path, { dataRoot: root });
      expect(migrated.getSchemaVersion()).toBe(6);
      expect(migrated.countJobs()).toBe(1);
      expect(migrated.enqueuePullRequest({ ...input, deliveryId: 'd2' })).toMatchObject({
        jobCreated: true,
      });
      expect(migrated.countJobs()).toBe(2);
      migrated.close();
      const verified = new DatabaseSync(path);
      expect(verified.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      const identityIndexes = verified.prepare('PRAGMA index_list(review_jobs)').all() as Array<{
        unique: number;
      }>;
      expect(identityIndexes.some((index) => index.unique === 1)).toBe(false);
      verified.close();

      const missingLedgerPath = join(root, 'missing-ledger.sqlite');
      const current = new JobDatabase(missingLedgerPath, { dataRoot: root });
      current.close();
      const missingLedger = new DatabaseSync(missingLedgerPath);
      missingLedger.exec('DELETE FROM schema_migrations');
      missingLedger.close();
      expect(() => new JobDatabase(missingLedgerPath, { dataRoot: root })).toThrow(
        /identity unique constraint is missing/,
      );

      const incompatiblePath = join(root, 'incompatible.sqlite');
      const incompatible = new DatabaseSync(incompatiblePath);
      incompatible.exec('CREATE TABLE review_jobs (id INTEGER PRIMARY KEY)');
      incompatible.close();
      expect(() => new JobDatabase(incompatiblePath, { dataRoot: root })).toThrow(/incompatible/);
      const afterFailure = new DatabaseSync(incompatiblePath);
      expect(
        (
          afterFailure.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
      afterFailure.close();

      const badConstraintPath = join(root, 'bad-constraint.sqlite');
      const badConstraint = new DatabaseSync(badConstraintPath);
      badConstraint.exec(`CREATE TABLE review_jobs (
        id INTEGER PRIMARY KEY, repository TEXT NOT NULL, pull_request_number INTEGER NOT NULL,
        head_sha TEXT NOT NULL, policy_version TEXT NOT NULL, installation_id INTEGER NOT NULL,
        action TEXT NOT NULL, delivery_id TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      )`);
      badConstraint.close();
      expect(() => new JobDatabase(badConstraintPath, { dataRoot: root })).toThrow(
        /unique constraint/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('backfills a valid result, is idempotent, and refuses paths outside data root', () => {
    const root = mkdtempSync('/tmp/leverframe-observability-');
    try {
      const jobs = join(root, 'jobs');
      mkdirSync(jobs);
      const path = join(jobs, 'result.json');
      writeFileSync(path, JSON.stringify(result));
      const databasePath = join(root, 'state.sqlite');
      const first = new JobDatabase(databasePath, { dataRoot: root });
      first.enqueuePullRequest({ ...input, deliveryId: 'valid' });
      const job = first.claimNextJob();
      if (!job) {
        throw new Error('missing job');
      }
      first.updateJob({ id: job.id, resultPath: path, state: 'DONE' });
      first.close();
      const second = new JobDatabase(databasePath, { dataRoot: root });
      expect(second.getReviewArtifact(job.id)?.result).toEqual(result);
      second.close();
      const outside = new JobDatabase(join(root, 'outside.sqlite'), { dataRoot: root });
      outside.enqueuePullRequest({ ...input, deliveryId: 'outside' });
      const outsideJob = outside.claimNextJob();
      if (!outsideJob) {
        throw new Error('missing outside job');
      }
      outside.updateJob({ id: outsideJob.id, resultPath: '/tmp/not-in-root.json', state: 'DONE' });
      outside.close();
      const verify = new JobDatabase(join(root, 'outside.sqlite'), { dataRoot: root });
      expect(verify.getReviewArtifact(outsideJob.id)).toMatchObject({
        available: false,
        unavailableReason: 'OUT_OF_ROOT',
      });
      verify.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps evaluation revisions append-only and rejects stale writes', () => {
    const database = new JobDatabase(':memory:');
    database.enqueuePullRequest(input);
    const job = database.claimNextJob();
    if (!job) {
      throw new Error('missing job');
    }
    database.updateJob({ id: job.id, state: 'DONE' });
    database.recordReviewArtifact(job.id, result);
    expect(() =>
      database.setEvaluation({ jobId: job.id, targetType: 'review', verdict: 'useful' } as never),
    ).toThrow(/expectedPreviousId/);
    const first = database.setEvaluation({
      jobId: job.id,
      targetType: 'review',
      verdict: 'useful',
      rationale: 'yes',
      expectedPreviousId: null,
    });
    const second = database.setEvaluation({
      jobId: job.id,
      targetType: 'review',
      verdict: 'mixed',
      expectedPreviousId: first.id,
    });
    expect(() =>
      database.setEvaluation({
        jobId: job.id,
        targetType: 'review',
        verdict: 'not_useful',
        expectedPreviousId: first.id,
      }),
    ).toThrow(EvaluationConflictError);
    expect(
      database.withdrawEvaluation({
        jobId: job.id,
        targetType: 'review',
        expectedPreviousId: second.id,
      }).action,
    ).toBe('withdraw');
    expect(database.getCurrentEvaluation(job.id, 'review')).toBeUndefined();
    expect(() =>
      database.withdrawEvaluation({
        jobId: job.id,
        targetType: 'review',
        expectedPreviousId: null,
      }),
    ).toThrow(/current evaluation/);
    expect(database.getEvaluationHistory(job.id, 'review')).toHaveLength(3);
    expect(() =>
      database.setEvaluation({
        jobId: job.id,
        targetType: 'finding',
        findingFingerprint: '0'.repeat(16),
        verdict: 'valid',
        expectedPreviousId: null,
      }),
    ).toThrow();
    database.close();
  });

  it('detects tampered artifact JSON and validates runtime input before storing', () => {
    const root = mkdtempSync('/tmp/leverframe-artifact-hash-');
    try {
      const path = join(root, 'state.sqlite');
      const database = new JobDatabase(path, { dataRoot: root });
      database.enqueuePullRequest(input);
      const job = database.claimNextJob();
      if (!job) {
        throw new Error('missing job');
      }
      database.updateJob({ id: job.id, state: 'DONE' });
      database.recordReviewArtifact(job.id, result);
      expect(() => database.recordReviewArtifact(job.id, { findings: [] } as never)).toThrow();
      database.close();
      const tamper = new DatabaseSync(path);
      tamper
        .prepare('UPDATE review_artifacts SET result_json=? WHERE job_id=?')
        .run(JSON.stringify({ ...result, summary: 'tampered' }), job.id);
      tamper.close();
      const reopened = new JobDatabase(path, { dataRoot: root });
      expect(reopened.getReviewArtifact(job.id)).toMatchObject({
        available: false,
        unavailableReason: 'CORRUPT_HASH',
      });
      reopened.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('redacts secrets and truncates by UTF-8 bytes', () => {
    const value = `Authorization: Bearer ghp_${'x'.repeat(30)}\n${'가'.repeat(20_000)}`;
    const excerpt = redactFailureExcerpt(value, { TEST_TOKEN: 'not-present' });
    expect(excerpt).not.toContain('ghp_');
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(FAILURE_EXCERPT_MAX_BYTES);
  });

  it('does not combine an unavailable newest head with older available history', () => {
    const root = mkdtempSync('/tmp/leverframe-history-transition-');
    try {
      const validPath = join(root, 'valid.json');
      writeFileSync(validPath, JSON.stringify(result));
      const database = new JobDatabase(join(root, 'state.sqlite'), { dataRoot: root });
      database.enqueuePullRequest({ ...input, deliveryId: 'old', headSha: '1'.repeat(40) });
      const old = database.claimNextJob();
      if (!old) {
        throw new Error('missing old job');
      }
      database.updateJob({ id: old.id, resultPath: validPath, state: 'DONE' });
      database.enqueuePullRequest({ ...input, deliveryId: 'new', headSha: '2'.repeat(40) });
      const newest = database.claimNextJob();
      if (!newest) {
        throw new Error('missing newest job');
      }
      database.updateJob({ id: newest.id, resultPath: join(root, 'missing.json'), state: 'DONE' });
      database.enqueuePullRequest({ ...input, deliveryId: 'current', headSha: '3'.repeat(40) });
      const current = database.claimNextJob();
      if (!current) {
        throw new Error('missing current job');
      }
      const previous = database.findPreviousCompletedReview(current);
      expect(previous?.headSha).toBe('2'.repeat(40));
      expect(
        selectReviewContext({
          baseSha: '0'.repeat(40),
          ...(previous === undefined ? {} : { previousReview: previous }),
        }).reviewMode,
      ).toBe('full');
      database.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
