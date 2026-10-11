import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../../src/github/credentials.js';
import type { SandboxReviewer } from '../../../src/sandbox/reviewer.js';
import { JobDatabase } from '../../../src/jobs/database.js';
import { ReviewWorker } from '../../../src/jobs/worker.js';

const githubMocks = vi.hoisted(() => ({
  appRequest: vi.fn(),
  installationRequest: vi.fn(),
}));

vi.mock('@octokit/app', () => ({
  App: vi.fn(function () {
    return {
      getInstallationOctokit: () => Promise.resolve({ request: githubMocks.installationRequest }),
      octokit: { request: githubMocks.appRequest },
    };
  }),
}));

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

describe('ReviewWorker Check Run start recovery', () => {
  it.each([
    { code: undefined, failedStarts: 1, name: 'one 404', state: 'DONE', status: 404 },
    {
      code: 'ECONNRESET',
      failedStarts: 1,
      name: 'a lost response',
      state: 'DONE',
      status: undefined,
    },
    { code: undefined, failedStarts: 3, name: 'persistent 404s', state: 'FAILED', status: 404 },
  ])(
    'handles $name without repeating review side effects',
    async (testCase) => {
      const directory = mkdtempSync(join(tmpdir(), 'leverframe-check-run-start-'));
      const database = new JobDatabase(':memory:');
      const headSha = 'a'.repeat(40);
      let startRequests = 0;
      let createdChecks = 0;
      let postedReviews = 0;
      const completions: unknown[] = [];
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      githubMocks.appRequest.mockImplementation((route: string) => {
        if (route === 'GET /app/installations/{installation_id}') {
          return { data: { account: { id: 1 } } };
        }
        if (route === 'POST /app/installations/{installation_id}/access_tokens') {
          return { data: { token: 'read-token' } };
        }
        throw new Error(`unexpected app route: ${route}`);
      });
      githubMocks.installationRequest.mockImplementation(
        (route: string, parameters: Record<string, unknown>) => {
          if (route === 'GET /repos/{owner}/{repo}/commits/{ref}/check-runs') {
            return { data: { check_runs: [] } };
          }
          if (route === 'POST /repos/{owner}/{repo}/check-runs') {
            createdChecks += 1;
            return { data: { id: 101 } };
          }
          if (route === 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}') {
            expect(parameters.check_run_id).toBe(101);
            if (parameters.status === 'in_progress') {
              startRequests += 1;
              if (startRequests <= testCase.failedStarts) {
                throw Object.assign(new Error('start request failed'), {
                  code: testCase.code,
                  status: testCase.status,
                });
              }
            } else {
              completions.push(parameters.conclusion);
            }
            return { data: {} };
          }
          if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}') {
            return {
              data: {
                base: {
                  ref: 'main',
                  repo: {
                    clone_url: 'https://github.com/example/project.git',
                    default_branch: 'main',
                    id: 99,
                  },
                  sha: 'b'.repeat(40),
                },
                draft: false,
                head: { sha: headSha },
                state: 'open',
                title: 'Test pull request',
              },
            };
          }
          if (route === 'GET /repos/{owner}/{repo}/contents/{path}') {
            throw Object.assign(new Error('missing policy'), { status: 404 });
          }
          if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            return { data: [] };
          }
          if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
            return { data: { id: 202 } };
          }
          if (route === 'PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}') {
            return { data: {} };
          }
          if (route === 'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
            return { data: [] };
          }
          if (route === 'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews') {
            postedReviews += 1;
            return { data: { id: 999 } };
          }
          throw new Error(`unexpected installation route: ${route}`);
        },
      );
      const review = vi.fn().mockResolvedValue({
        path: join(directory, 'review-result.json'),
        result: { findings: [], limitations: [], summary: 'No defects', tests_run: [] },
        reviewMode: 'full',
        reviewableLines: new Map(),
      });
      const worker = new ReviewWorker({
        allowedOwnerId: 1,
        credentials: {
          exists: () => true,
          read: () => ({ appId: 1, privateKey: 'private-key' }),
        } as unknown as CredentialStore,
        database,
        jobsDirectory: join(directory, 'jobs'),
        reviewer: { review } as unknown as SandboxReviewer,
      });
      database.enqueuePullRequest({
        action: 'opened',
        deliveryId: 'delivery-1',
        headSha,
        installationId: 42,
        policyVersion: 'v1',
        pullRequestNumber: 7,
        repository: 'example/project',
      });
      try {
        worker.start();
        await vi.waitFor(() => expect(completions).toHaveLength(1), { timeout: 5_000 });
        await worker.stop();

        const succeeded = testCase.state === 'DONE';
        const job = database.getLatestJobStatus('example/project', 7);
        if (job === undefined) {
          throw new Error('expected the review job to remain stored');
        }
        expect(database.getReviewJob(job.id)).toMatchObject({
          attempt: 1,
          checkRunId: 101,
          state: testCase.state,
        });
        expect(startRequests).toBe(succeeded ? 2 : 3);
        expect(createdChecks).toBe(1);
        expect(review).toHaveBeenCalledTimes(succeeded ? 1 : 0);
        expect(postedReviews).toBe(succeeded ? 1 : 0);
        expect(completions).toEqual([succeeded ? 'neutral' : 'failure']);
      } finally {
        await worker.stop();
        database.close();
        rmSync(directory, { force: true, recursive: true });
      }
    },
    10_000,
  );
});
