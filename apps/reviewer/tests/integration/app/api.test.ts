import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  contextResponseSchema,
  evaluationWriteResponseSchema,
  evaluationsResponseSchema,
  reviewDetailSchema,
  reviewExecutionSnapshotSchema,
  reviewListResponseSchema,
  statusResponseSchema,
} from '@repo/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { createLeverframeServer } from '../../../src/app/server.js';
import { ExecutionTraceStore } from '../../../src/execution/trace.js';
import { CredentialStore } from '../../../src/github/credentials.js';
import { JobDatabase } from '../../../src/jobs/database.js';
import { findingFingerprint } from '../../../src/review/result.js';

const config = {
  allowedOwnerId: 1,
  credentialsDirectory: '/unused',
  databasePath: ':memory:',
  host: '127.0.0.1',
  jobsDirectory: '/unused/jobs',
  githubAppName: 'test',
  model: 'model',
  port: 6571,
  uiBaseUrl: 'https://leverframe.retn0.dev',
  webhookUrl: 'https://example.test/webhooks/github',
  reasoningEffort: 'low' as const,
  resourcesDirectory: '/unused',
  sandboxTemplate: `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
  development: {
    commitSkillDirectory: '/agent-skills/commit',
    createPrSkillDirectory: '/agent-skills/create-pr',
    verificationCommand: 'pnpm check',
  },
};
const result = {
  coverage: {
    changed_files: ['src/a.ts'],
    complete: true,
    omitted_files: [],
    reviewed_files: ['src/a.ts'],
  },
  finding_updates: [],
  findings: [
    {
      confidence: 'high' as const,
      evidence: 'stored context',
      explanation: 'bad path',
      file: 'src/a.ts',
      line: 12,
      severity: 'high' as const,
      suggested_action: 'fix it',
      title: 'Bug',
    },
  ],
  limitations: [],
  summary: 'one finding',
  tests_run: [],
};
const cleanup: Array<() => void> = [];

afterEach(() => {
  for (const close of cleanup.splice(0)) {
    close();
  }
});

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'leverframe-api-'));
  const credentials = new CredentialStore(directory);
  credentials.write({
    appId: 1,
    clientId: 'client',
    name: 'test',
    privateKey: 'private',
    slug: 'test',
    webhookSecret: 'long-enough-secret',
  });
  const database = new JobDatabase(':memory:');
  database.enqueuePullRequest({
    action: 'opened',
    deliveryId: 'delivery-1',
    headSha: 'b'.repeat(40),
    baseSha: 'a'.repeat(40),
    installationId: 42,
    policyVersion: 'v1',
    pullRequestNumber: 1,
    pullRequestTitle: 'A title',
    repository: 'owner/repo',
  });
  const job = database.claimNextJob();
  if (job === undefined) {
    throw new Error('fixture job was not claimed');
  }
  database.updateJob({
    id: job.id,
    state: 'DONE',
    expectedStates: ['CHECKING_OUT'],
    ...(job.attempt === undefined ? {} : { attempt: job.attempt }),
  });
  database.recordReviewArtifact(job.id, result);
  const traceStore = new ExecutionTraceStore(join(directory, 'jobs'));
  const server = createLeverframeServer(
    { ...config, jobsDirectory: join(directory, 'jobs') },
    database,
    credentials,
    {},
    traceStore,
  );
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  cleanup.push(
    () => server.close(),
    () => database.close(),
    () => rmSync(directory, { recursive: true, force: true }),
  );
  return { database, job, traceStore, url: `http://127.0.0.1:${address.port}` };
}

describe('versioned reviewer API contracts', () => {
  it('reports unknown dependencies until they have been observed', async () => {
    const { url } = await fixture();
    const response = await fetch(`${url}/api/v1/status`);
    expect(response.status).toBe(200);
    const parsed = statusResponseSchema.parse(await response.json());
    expect(parsed.overall).toBe('unknown');
    expect(parsed.worker.status).toBe('unknown');
    expect(parsed.sandbox.status).toBe('unknown');
  });

  it('exposes a pull request title in list and detail responses before claiming the job', async () => {
    const { database, url } = await fixture();
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'queued-title-delivery',
      headSha: 'c'.repeat(40),
      installationId: 42,
      policyVersion: 'v2',
      pullRequestNumber: 2,
      pullRequestTitle: 'Visible while queued',
      repository: 'owner/repo',
    });
    const queued = database.listReviewJobs({ page: 1 }).items[0];
    if (queued === undefined) {
      throw new Error('queued fixture job was not persisted');
    }

    const list = reviewListResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews?page=1`)).json(),
    );
    expect(list.items[0]).toMatchObject({
      id: queued.id,
      pull_request_title: 'Visible while queued',
      status: 'queued',
    });

    const detail = reviewDetailSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${queued.id}`)).json(),
    );
    expect(detail).toMatchObject({
      id: queued.id,
      pull_request_title: 'Visible while queued',
      status: 'queued',
    });
  });

  it('returns a bounded execution snapshot and resumable terminal SSE stream', async () => {
    const { job, traceStore, url } = await fixture();
    traceStore.append(job.id, job.attempt ?? 1, { type: 'attempt_started' });
    traceStore.append(job.id, job.attempt ?? 1, {
      type: 'command_completed',
      itemId: 'cmd_1',
      command: 'pnpm test',
      exitCode: 0,
      output: 'passed',
      status: 'completed',
    });
    const response = await fetch(`${url}/api/v1/reviews/${job.id}/execution`);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const snapshot = reviewExecutionSnapshotSchema.parse(await response.json());
    expect(snapshot.status).toBe('completed');
    expect(snapshot.events).toHaveLength(2);
    expect(snapshot.events[1]).toMatchObject({ command: 'pnpm test', exit_code: 0 });

    const stream = await fetch(`${url}/api/v1/reviews/${job.id}/execution/events?after=1`);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const body = await stream.text();
    expect(body).toContain('id: 2');
    expect(body).toContain('event: trace');
    expect(body).toContain('event: snapshot');
    expect(body).not.toContain('id: 1');
  });

  it('lists stable page-20 results and validates detail/evaluation/context contracts', async () => {
    const { url, database, job } = await fixture();
    for (let number = 2; number <= 22; number += 1) {
      database.enqueuePullRequest({
        action: 'opened',
        deliveryId: `delivery-${number}`,
        headSha: number.toString().padStart(40, '0'),
        installationId: 42,
        policyVersion: 'v1',
        pullRequestNumber: number,
        repository: 'owner/repo',
      });
    }
    const list = reviewListResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews?page=1`)).json(),
    );
    expect(list.page_size).toBe(20);
    expect(list.items).toHaveLength(20);
    expect(list.items[0]?.id).toBeGreaterThan(list.items[1]?.id ?? 0);
    expect((await fetch(`${url}/api/v1/reviews?status=completed`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/reviews?status=Completed`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/reviews?status=completed,FAILED`)).status).toBe(200);
    expect((await fetch(`${url}/api/v1/reviews?page=0`)).status).toBe(422);
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'timed-out-delivery',
      headSha: 'c'.repeat(40),
      installationId: 42,
      policyVersion: 'v1',
      pullRequestNumber: 99,
      repository: 'owner/repo',
    });
    const timedOut = database.claimNextJob();
    if (timedOut === undefined) {
      throw new Error('timed out fixture was not claimed');
    }
    database.updateJob({ id: timedOut.id, state: 'TIMED_OUT', expectedStates: ['CHECKING_OUT'] });
    const failedList = reviewListResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews?status=failed`)).json(),
    );
    expect(failedList.items.some((item) => item.id === timedOut.id)).toBe(true);
    const combinedStatusList = reviewListResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews?status=completed,failed&status=superseded`)).json(),
    );
    expect(combinedStatusList.items.map((item) => item.status)).toEqual(
      expect.arrayContaining(['completed', 'failed']),
    );
    expect(combinedStatusList.items.every((item) => item.status !== 'queued')).toBe(true);
    expect((await fetch(`${url}/api/v1/reviews?page_size=100`)).status).toBe(422);
    const detail = reviewDetailSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}`)).json(),
    );
    expect(detail.artifact.available).toBe(true);
    const firstFinding = result.findings[0];
    if (firstFinding === undefined) {
      throw new Error('fixture finding is missing');
    }
    const fingerprint = findingFingerprint(firstFinding);
    database.recordGitHubThreadAssociation({
      commentNodeId: 'PRRC_comment',
      fingerprint,
      jobId: job.id,
      pullRequestNumber: job.pullRequestNumber,
      repository: job.repository,
      reviewDatabaseId: '99',
      threadNodeId: 'PRRT_thread',
    });
    const detailWithThread = reviewDetailSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}`)).json(),
    );
    expect(detailWithThread.artifact.findings[0]?.thread_resolution).toMatchObject({
      state: 'open',
    });
    const context = contextResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}/findings/${fingerprint}/context`)).json(),
    );
    expect(context.source).toBe('stored_evidence');
    const saved = evaluationWriteResponseSchema.parse(
      await (
        await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            verdict: 'useful',
            rationale: 'looks good',
            expected_previous_id: null,
          }),
        })
      ).json(),
    );
    expect(saved.current?.verdict).toBe('useful');
    expect(
      evaluationsResponseSchema.parse(
        await (await fetch(`${url}/api/v1/reviews/${job.id}/evaluations`)).json(),
      ).review.current?.verdict,
    ).toBe('useful');
    expect((await fetch(`${url}/api/v1/reviews/999999`)).status).toBe(404);
  });

  it('can sort completed runs by completion time rather than creation time', async () => {
    const { url, database } = await fixture();
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'older-created',
      headSha: 'd'.repeat(40),
      installationId: 42,
      policyVersion: 'v1',
      pullRequestNumber: 100,
      repository: 'owner/repo',
    });
    const older = database.claimNextJob();
    if (older === undefined) {
      throw new Error('older fixture job was not claimed');
    }
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'newer-created',
      headSha: 'e'.repeat(40),
      installationId: 42,
      policyVersion: 'v1',
      pullRequestNumber: 101,
      repository: 'owner/repo',
    });
    const newer = database.claimNextJob();
    if (newer === undefined) {
      throw new Error('newer fixture job was not claimed');
    }
    database.updateJob({ id: newer.id, state: 'VALIDATING', expectedStates: ['CHECKING_OUT'] });
    database.updateJob({ id: newer.id, state: 'DONE', expectedStates: ['VALIDATING'] });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 2);
    });
    database.updateJob({ id: older.id, state: 'VALIDATING', expectedStates: ['CHECKING_OUT'] });
    database.updateJob({ id: older.id, state: 'DONE', expectedStates: ['VALIDATING'] });

    const sorted = reviewListResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews?sort=completed`)).json(),
    );
    expect(sorted.items[0]?.id).toBe(older.id);
    expect(sorted.items[1]?.id).toBe(newer.id);
  });

  it('returns contract errors for malformed JSON and invalid withdraw revisions', async () => {
    const { url, job } = await fixture();
    const malformed = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformed.status).toBe(422);
    await expect(malformed.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    const invalidWithdraw = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_previous_id: 'bad' }),
    });
    expect(invalidWithdraw.status).toBe(422);
    await expect(invalidWithdraw.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    const missingWithdrawBody = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'DELETE',
    });
    expect(missingWithdrawBody.status).toBe(422);
    await expect(missingWithdrawBody.json()).resolves.toMatchObject({ code: 'INVALID_REQUEST' });
    const malformedWithdraw = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    expect(malformedWithdraw.status).toBe(422);
    const set = evaluationWriteResponseSchema.parse(
      await (
        await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ verdict: 'mixed', expected_previous_id: null }),
        })
      ).json(),
    );
    if (set.current === null) {
      throw new Error('evaluation was not created');
    }
    const withdrawn = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_previous_id: set.current?.id }),
    });
    expect(withdrawn.status).toBe(200);
    const evaluations = evaluationsResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}/evaluations`)).json(),
    );
    expect(evaluations.review.current).toBeNull();
    expect(evaluations.review.history[0]?.action).toBe('withdraw');
  });

  it('enforces target-specific verdicts and supports lost-response recovery', async () => {
    const { url, job } = await fixture();
    const finding = result.findings[0];
    if (finding === undefined) {
      throw new Error('fixture finding is missing');
    }
    const fingerprint = findingFingerprint(finding);

    const invalidReviewVerdict = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ verdict: 'false_positive', expected_previous_id: null }),
    });
    expect(invalidReviewVerdict.status).toBe(422);
    await expect(invalidReviewVerdict.json()).resolves.toMatchObject({ code: 'INVALID_VERDICT' });

    const invalidFindingVerdict = await fetch(
      `${url}/api/v1/reviews/${job.id}/findings/${fingerprint}/evaluation`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ verdict: 'useful', expected_previous_id: null }),
      },
    );
    expect(invalidFindingVerdict.status).toBe(422);
    await expect(invalidFindingVerdict.json()).resolves.toMatchObject({
      code: 'INVALID_VERDICT',
    });

    const firstWrite = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'useful',
        rationale: 'Human approved this evaluation.',
        expected_previous_id: null,
      }),
    });
    expect(firstWrite.status).toBe(200);

    const recovered = evaluationsResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}/evaluations`)).json(),
    );
    expect(recovered.review.current).toMatchObject({
      verdict: 'useful',
      rationale: 'Human approved this evaluation.',
    });
    expect(recovered.review.history).toHaveLength(1);

    const unsafeRetry = await fetch(`${url}/api/v1/reviews/${job.id}/evaluation`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        verdict: 'useful',
        rationale: 'Human approved this evaluation.',
        expected_previous_id: null,
      }),
    });
    expect(unsafeRetry.status).toBe(409);
    await expect(unsafeRetry.json()).resolves.toMatchObject({
      code: 'STALE_EVALUATION',
      details: { id: recovered.review.current?.id },
    });
    const afterRetry = evaluationsResponseSchema.parse(
      await (await fetch(`${url}/api/v1/reviews/${job.id}/evaluations`)).json(),
    );
    expect(afterRetry.review.history).toHaveLength(1);
  });

  it('excludes a valid-but-tampered artifact from findings and needs-evaluation', () => {
    const root = mkdtempSync(join(tmpdir(), 'leverframe-api-tamper-'));
    const path = join(root, 'state.sqlite');
    const database = new JobDatabase(path, { dataRoot: root });
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: 'tamper-delivery',
      headSha: 'd'.repeat(40),
      baseSha: 'e'.repeat(40),
      installationId: 42,
      policyVersion: 'v1',
      pullRequestNumber: 3,
      repository: 'owner/repo',
    });
    const job = database.claimNextJob();
    if (job === undefined) {
      throw new Error('tamper fixture was not claimed');
    }
    database.updateJob({ id: job.id, state: 'DONE' });
    database.recordReviewArtifact(job.id, result);
    database.close();
    const tamper = new DatabaseSync(path);
    tamper
      .prepare('UPDATE review_artifacts SET result_json=? WHERE job_id=?')
      .run(JSON.stringify({ ...result, summary: 'tampered but valid JSON' }), job.id);
    tamper.close();
    const reopened = new JobDatabase(path, { dataRoot: root });
    const list = reopened.listReviewJobs({ page: 1, evaluation: 'needs_evaluation' });
    expect(list.totalItems).toBe(0);
    expect(list.items[0]?.findingsCount ?? 0).toBe(0);
    reopened.close();
    rmSync(root, { recursive: true, force: true });
  });
});
