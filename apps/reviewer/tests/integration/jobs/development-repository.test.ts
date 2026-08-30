import { describe, expect, it } from 'vitest';
import { openDatabase } from '../../../src/storage/connection.js';
import {
  DevelopmentConflictError,
  DevelopmentRepository,
} from '../../../src/storage/development-repository.js';
import { runMigrations, schemaVersion } from '../../../src/storage/migrations/index.js';

const now = '2026-08-30T00:00:00.000Z';
const later = '2026-08-30T00:05:00.000Z';
const candidateA = 'a'.repeat(64);
const candidateB = 'b'.repeat(64);

function setup() {
  const database = openDatabase(':memory:');
  runMigrations(database);
  return { database, repository: new DevelopmentRepository(database) };
}

describe('DevelopmentRepository', () => {
  it('migrates to schema 7 and creates web-native work without an external provider', () => {
    const { database, repository } = setup();
    const run = repository.createRun({
      goal: 'Build a Leverframe-owned development loop.',
      repository: 'example/leverframe',
      now,
    });

    expect(schemaVersion(database)).toBe(7);
    expect(run).toMatchObject({
      generation: 1,
      goal: 'Build a Leverframe-owned development loop.',
      lockVersion: 1,
      phase: 'INTAKE',
      revision: 1,
    });
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM development_external_refs').get(),
    ).toEqual({ count: 0 });
    database.prepare('DELETE FROM development_runs WHERE id = ?').run(run.id);
    expect(
      database.prepare('SELECT COUNT(*) AS count FROM development_work_revisions').get(),
    ).toEqual({ count: 0 });
    database.close();
  });

  it('stores ticket providers only as optional revision and external-reference data', () => {
    const { database, repository } = setup();
    const first = repository.createRun({
      goal: 'Import from one ticket system.',
      repository: 'example/leverframe',
      externalSource: { provider: 'multica', id: 'ticket-59', key: 'PER-59' },
      now,
    });
    const second = repository.createRun({
      goal: 'Import from another ticket system.',
      repository: 'example/leverframe',
      externalSource: { provider: 'linear', id: 'issue-1', key: 'ENG-1' },
      now,
    });

    expect([first.goal, second.goal]).toHaveLength(2);
    expect(
      database
        .prepare('SELECT provider, external_id FROM development_external_refs ORDER BY provider')
        .all(),
    ).toEqual([
      { provider: 'linear', external_id: 'issue-1' },
      { provider: 'multica', external_id: 'ticket-59' },
    ]);
    const runColumns = database.prepare('PRAGMA table_info(development_runs)').all() as Array<{
      name: string;
    }>;
    expect(runColumns.some((column) => column.name.startsWith('multica_'))).toBe(false);
    database.close();
  });

  it('allows only one of 100 stale claim contenders to own a run', () => {
    const { database, repository } = setup();
    const run = repository.createRun({
      goal: 'Claim once.',
      repository: 'example/leverframe',
      now,
    });
    const outcomes = Array.from({ length: 100 }, (_, index) => {
      try {
        return repository.claimAttempt({
          runId: run.id,
          expectedGeneration: run.generation,
          expectedLockVersion: run.lockVersion,
          phase: 'PREPARING',
          executorKind: 'CODEX_APP_SERVER',
          leaseOwner: `worker-${index}`,
          leaseExpiresAt: later,
          now,
        });
      } catch (error) {
        expect(error).toBeInstanceOf(DevelopmentConflictError);
        return undefined;
      }
    });

    expect(outcomes.filter((outcome) => outcome !== undefined)).toHaveLength(1);
    expect(
      database
        .prepare(
          "SELECT COUNT(*) AS count FROM development_attempts WHERE state IN ('CLAIMED','RUNNING','WAITING')",
        )
        .get(),
    ).toEqual({ count: 1 });
    database.close();
  });

  it('rejects stale generation transitions and duplicate event intents', () => {
    const { database, repository } = setup();
    const run = repository.createRun({
      goal: 'Fence callbacks.',
      repository: 'example/leverframe',
      now,
    });
    const transitioned = repository.transition({
      id: run.id,
      expectedGeneration: run.generation,
      expectedLockVersion: run.lockVersion,
      phase: 'PREPARING',
      advanceGeneration: true,
      event: {
        type: 'preparing_started',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
        observedAt: later,
      },
    });

    expect(transitioned.generation).toBe(2);
    expect(() =>
      repository.transition({
        id: transitioned.id,
        expectedGeneration: transitioned.generation,
        expectedLockVersion: transitioned.lockVersion,
        phase: 'PUBLISHING',
        event: { type: 'illegal_jump', source: 'LEVERFRAME', trust: 'SYSTEM_OBSERVED' },
      }),
    ).toThrow(/illegal development transition/);
    expect(() =>
      repository.transition({
        id: run.id,
        expectedGeneration: run.generation,
        expectedLockVersion: run.lockVersion,
        phase: 'PLANNING',
        event: { type: 'stale', source: 'CODEX', trust: 'HARNESS_OBSERVED' },
      }),
    ).toThrow(DevelopmentConflictError);
    const event = {
      type: 'sandbox_observed',
      source: 'SANDBOX' as const,
      trust: 'SYSTEM_OBSERVED' as const,
      idempotencyKey: 'sandbox-observation-1',
    };
    repository.appendEvent(run.id, transitioned.generation, event);
    expect(() => repository.appendEvent(run.id, transitioned.generation, event)).toThrow(
      /UNIQUE constraint failed/,
    );
    database.close();
  });

  it('binds evidence and publication approval to the exact candidate', () => {
    const { database, repository } = setup();
    const initial = repository.createRun({
      goal: 'Verify exact candidates.',
      repository: 'example/leverframe',
      now,
    });
    const first = repository.setCandidate({
      id: initial.id,
      expectedGeneration: initial.generation,
      expectedLockVersion: initial.lockVersion,
      candidateHash: candidateA,
      event: {
        type: 'candidate_observed',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
        observedAt: now,
      },
    });
    expect(
      repository.recordEvidence({
        runId: first.id,
        workRevisionId: first.workRevisionId,
        generation: first.generation,
        candidateHash: candidateA,
        criterion: 'Targeted tests pass.',
        method: 'COMMAND',
        observation: 'Test process exited successfully.',
        trust: 'SYSTEM_OBSERVED',
        verdict: 'PASSED',
        now,
      }),
    ).toBeGreaterThan(0);
    expect(() =>
      repository.recordEvidence({
        runId: first.id,
        workRevisionId: first.workRevisionId,
        generation: first.generation,
        candidateHash: candidateA,
        criterion: 'Agent says it works.',
        method: 'INSPECTION',
        observation: 'Unverified model prose.',
        trust: 'AGENT_CLAIMED',
        verdict: 'PASSED',
        now,
      }),
    ).toThrow(/CHECK constraint failed/);
    const approvalId = repository.openPublicationApproval({
      runId: first.id,
      workRevisionId: first.workRevisionId,
      generation: first.generation,
      candidateHash: candidateA,
      publicationKind: 'PUSH_AND_PR',
      prompt: 'Publish this exact candidate?',
      now,
    });
    const second = repository.setCandidate({
      id: first.id,
      expectedGeneration: first.generation,
      expectedLockVersion: first.lockVersion,
      candidateHash: candidateB,
      event: {
        type: 'candidate_changed',
        source: 'LEVERFRAME',
        trust: 'SYSTEM_OBSERVED',
        observedAt: later,
      },
    });

    expect(second.candidateHash).toBe(candidateB);
    expect(() =>
      repository.resolvePublicationApproval({
        interruptId: approvalId,
        expectedLockVersion: 1,
        candidateHash: candidateA,
        approve: true,
        now: later,
      }),
    ).toThrow(DevelopmentConflictError);
    expect(() =>
      repository.recordEvidence({
        runId: second.id,
        workRevisionId: second.workRevisionId,
        generation: second.generation,
        candidateHash: candidateA,
        criterion: 'Old evidence.',
        method: 'COMMAND',
        observation: 'Belongs to the prior candidate.',
        trust: 'SYSTEM_OBSERVED',
        verdict: 'PASSED',
        now: later,
      }),
    ).toThrow(DevelopmentConflictError);
    expect(
      database.prepare('SELECT status FROM development_interrupts WHERE id = ?').get(approvalId),
    ).toEqual({ status: 'SUPERSEDED' });
    database.close();
  });

  it('represents retained resources and cleanup failure independently from run completion', () => {
    const { database, repository } = setup();
    const run = repository.createRun({
      goal: 'Preserve recoverable work.',
      repository: 'example/leverframe',
      now,
    });
    database
      .prepare(`
        INSERT INTO development_resources (
          run_id, kind, provider, external_id, state, generation, observed_at, created_at, updated_at
        ) VALUES (?, 'WORKSPACE', 'filesystem', 'opaque-workspace-1', 'RETAINED', 1, ?, ?, ?)
      `)
      .run(run.id, now, now, now);
    database
      .prepare(`
        UPDATE development_resources
        SET state = 'CLEANUP_FAILED', last_error = 'workspace is dirty', updated_at = ?
        WHERE run_id = ? AND kind = 'WORKSPACE'
      `)
      .run(later, run.id);

    expect(
      database
        .prepare('SELECT state, last_error FROM development_resources WHERE run_id = ?')
        .get(run.id),
    ).toEqual({ state: 'CLEANUP_FAILED', last_error: 'workspace is dirty' });
    expect(repository.requireRun(run.id).phase).toBe('INTAKE');
    database.close();
  });
});
