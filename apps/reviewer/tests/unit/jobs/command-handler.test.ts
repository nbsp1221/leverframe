import { describe, expect, it, vi } from 'vitest';
import type { CredentialStore } from '../../../src/github/credentials.js';
import type { ReviewWorker } from '../../../src/jobs/worker.js';
import { ManualCommandHandler } from '../../../src/jobs/command-handler.js';
import { JobDatabase } from '../../../src/jobs/database.js';

const githubMocks = vi.hoisted(() => ({
  actorCanManagePullRequest: vi.fn(),
  createCommandReply: vi.fn(),
  getPullRequest: vi.fn(),
}));

vi.mock('../../../src/github/client.js', () => ({
  GitHubAppClient: vi.fn(function () {
    return githubMocks;
  }),
}));

describe('manual review command handling', () => {
  it('persists the fetched pull request title when enqueueing a review', async () => {
    githubMocks.actorCanManagePullRequest.mockResolvedValue(true);
    githubMocks.createCommandReply.mockResolvedValue(1);
    githubMocks.getPullRequest.mockResolvedValue({
      baseRef: 'main',
      baseSha: 'a'.repeat(40),
      cloneUrl: 'https://example.test/owner/repo.git',
      defaultBranch: 'main',
      draft: false,
      headSha: 'b'.repeat(40),
      repositoryId: 1,
      state: 'open',
      title: 'Current pull request title',
    });
    const database = new JobDatabase(':memory:');
    const cancelSuperseded = vi.fn();
    const worker = { cancelSuperseded } as unknown as ReviewWorker;
    const credentials = { read: vi.fn(() => ({})) } as unknown as CredentialStore;

    try {
      const handler = new ManualCommandHandler({ credentials, database, worker });
      await expect(
        handler.handle({
          actor: 'octocat',
          command: 'review',
          commentId: 99,
          deliveryId: 'manual-delivery',
          installationId: 42,
          pullRequestNumber: 7,
          repository: 'owner/repo',
        }),
      ).resolves.toEqual({ status: 'queued' });

      expect(database.listReviewJobs({ page: 1 }).items[0]).toMatchObject({
        pullRequestTitle: 'Current pull request title',
        state: 'QUEUED',
      });
      expect(cancelSuperseded).toHaveBeenCalledWith(
        expect.objectContaining({ pullRequestTitle: 'Current pull request title' }),
      );
    } finally {
      database.close();
    }
  });
});
