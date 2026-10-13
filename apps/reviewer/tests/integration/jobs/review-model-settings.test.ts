import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../../src/github/credentials.js';
import { ExecutionTraceStore } from '../../../src/execution/trace.js';
import { JobDatabase } from '../../../src/jobs/database.js';
import { ReviewWorker } from '../../../src/jobs/worker.js';
import { SandboxReviewer } from '../../../src/sandbox/reviewer.js';
import { runProcess, runStreamingProcess } from '../../../src/system/process.js';

const github = vi.hoisted(() => ({
  createQueuedCheckRun: vi.fn(),
  startCheckRun: vi.fn(),
  getPullRequest: vi.fn(),
  createRepositoryReadToken: vi.fn(),
  getRepositoryTextFile: vi.fn(),
  findStatusComment: vi.fn(),
  createStatusComment: vi.fn(),
  updateStatusComment: vi.fn(),
  publishReview: vi.fn(),
  completeCheckRun: vi.fn(),
}));
vi.mock('../../../src/github/client.js', () => ({
  GitHubAppClient: vi.fn(function () {
    return github;
  }),
}));
vi.mock('../../../src/system/process.js', () => ({
  runProcess: vi.fn(),
  runStreamingProcess: vi.fn(),
}));

it('keeps an active job on its starting pair and uses a saved pair for the next queued job, including Codex arguments and stored metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'leverframe-model-execution-'));
  const database = new JobDatabase(join(root, 'state.sqlite'));
  const jobsDirectory = join(root, 'jobs');
  const resourcesDirectory = join(root, 'resources');
  mkdirSync(resourcesDirectory);
  writeFileSync(join(resourcesDirectory, 'review-prompt.md'), 'Review carefully.');
  writeFileSync(join(resourcesDirectory, 'review-schema.json'), '{"type":"object"}');
  const headSha = 'a'.repeat(40);
  github.getPullRequest.mockResolvedValue({
    baseRef: 'main',
    baseSha: 'b'.repeat(40),
    cloneUrl: 'https://github.com/example/project.git',
    defaultBranch: 'main',
    draft: false,
    headSha,
    repositoryId: 99,
    state: 'open',
    title: 'Test review',
  });
  github.createRepositoryReadToken.mockResolvedValue('test-token');
  github.createStatusComment.mockResolvedValue(123);
  github.publishReview.mockResolvedValue({ reviewId: 456, publishedInlineFingerprints: [] });
  let signalStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  github.createQueuedCheckRun
    .mockImplementationOnce(async () => {
      signalStarted();
      await released;
      return 1;
    })
    .mockResolvedValue(2);
  vi.mocked(runProcess).mockImplementation((_command, args) =>
    Promise.resolve({
      stderr: '',
      stdout:
        args[0] === 'version'
          ? 'sbx version: v0.39.0 test\n'
          : args[0] === 'exec' && args.includes('cat')
            ? '{"findings":[],"limitations":[],"summary":"No defects.","tests_run":[]}'
            : args.includes('rev-parse')
              ? `${headSha}\n`
              : '',
    }),
  );
  const original = { model: 'gpt-6-astra', reasoningEffort: 'high' as const };
  const next = { model: 'gpt-6.1-sol', reasoningEffort: 'xhigh' as const };
  database.reviewSettings.save(original);
  const worker = new ReviewWorker({
    allowedOwnerId: 1,
    credentials: { exists: () => true, read: () => ({}) } as unknown as CredentialStore,
    database,
    jobsDirectory,
    getModelSettings: () => database.reviewSettings.get(original),
    reviewer: new SandboxReviewer({
      model: 'unused-startup-model',
      reasoningEffort: 'low',
      resourcesDirectory,
      sandboxTemplate: `leverframe-review-sandbox:sha256-${'a'.repeat(64)}`,
      traceStore: new ExecutionTraceStore(jobsDirectory),
    }),
  });
  for (const number of [1, 2]) {
    database.enqueuePullRequest({
      action: 'opened',
      deliveryId: `delivery-${number}`,
      headSha,
      installationId: 1,
      policyVersion: 'v1',
      pullRequestNumber: number,
      repository: 'example/project',
    });
  }
  try {
    worker.start();
    await started;
    database.reviewSettings.save(next);
    release();
    await vi.waitFor(
      () => expect(database.getLatestJobStatus('example/project', 2)?.state).toBe('DONE'),
      { timeout: 5000 },
    );
    await worker.stop();
    const calls = vi.mocked(runStreamingProcess).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [index, settings] of [original, next].entries()) {
      const args = calls[index]![1];
      expect(args[args.indexOf('--model') + 1]).toBe(settings.model);
      expect(args[args.indexOf('--config') + 1]).toBe(
        `model_reasoning_effort="${settings.reasoningEffort}"`,
      );
      const job = database.getLatestJobStatus('example/project', index + 1)!;
      expect(database.getReviewJob(job.id)).toMatchObject({
        model: settings.model,
        reasoning: settings.reasoningEffort,
        state: 'DONE',
      });
    }
  } finally {
    release();
    await worker.stop();
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
