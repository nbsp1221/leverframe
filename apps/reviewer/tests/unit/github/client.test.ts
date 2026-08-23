import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GitHubAppClient,
  canManageRepositoryRole,
  limitGitHubBody,
  repositoryReadTokenRequest,
} from '../../../src/github/client.js';
import { githubRetryDelayMilliseconds } from '../../../src/github/retry.js';
import { GitHubReviewThreadClient } from '../../../src/github/review-thread-client.js';

const githubMocks = vi.hoisted(() => ({
  appRequest: vi.fn(),
  getInstallationOctokit: vi.fn(),
  graphql: vi.fn(),
  installationRequest: vi.fn(),
}));

vi.mock('@octokit/app', () => ({
  App: vi.fn(function () {
    return {
      getInstallationOctokit: githubMocks.getInstallationOctokit,
      octokit: { request: githubMocks.appRequest },
    };
  }),
}));

beforeEach(() => {
  vi.clearAllMocks();
  githubMocks.getInstallationOctokit.mockResolvedValue({
    graphql: githubMocks.graphql,
    request: githubMocks.installationRequest,
  });
});

describe('GitHub output limits', () => {
  it('keeps short bodies unchanged and marks truncated output', () => {
    expect(limitGitHubBody('short', 10)).toBe('short');

    const truncated = limitGitHubBody('x'.repeat(200), 80);
    expect(truncated).toHaveLength(80);
    expect(truncated).toContain('Review output was truncated');
  });
});

describe('Sandbox repository token scope', () => {
  it('limits the token to one repository with read-only contents access', () => {
    expect(repositoryReadTokenRequest(42, 99)).toEqual({
      installation_id: 42,
      permissions: { contents: 'read' },
      repository_ids: [99],
    });
  });
});

describe('GitHub retry classification', () => {
  it('backs off for transient and rate-limited responses', () => {
    expect(githubRetryDelayMilliseconds({ status: 503 }, 0)).toBe(500);
    expect(
      githubRetryDelayMilliseconds(
        {
          response: { headers: { 'retry-after': '2' } },
          status: 429,
        },
        0,
      ),
    ).toBe(2_000);
    expect(githubRetryDelayMilliseconds({ code: 'ECONNRESET' }, 1)).toBe(1_000);
  });

  it('does not retry authentication or validation failures', () => {
    expect(githubRetryDelayMilliseconds({ status: 401 }, 0)).toBeUndefined();
    expect(githubRetryDelayMilliseconds({ status: 422 }, 0)).toBeUndefined();
  });
});

describe('manual command authorization', () => {
  it('accepts triage-or-higher roles and rejects read-only roles', () => {
    expect(canManageRepositoryRole('triage')).toBe(true);
    expect(canManageRepositoryRole('write')).toBe(true);
    expect(canManageRepositoryRole('admin')).toBe(true);
    expect(canManageRepositoryRole('read')).toBe(false);
    expect(canManageRepositoryRole('none')).toBe(false);
  });
});

describe('manual command reply delivery', () => {
  it('reconciles an ambiguous comment POST and does not post again on redelivery', async () => {
    let postAttempts = 0;
    let commentLookups = 0;
    githubMocks.installationRequest.mockImplementation((route: string) => {
      if (route === 'GET /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        commentLookups += 1;
        return {
          data:
            commentLookups === 1
              ? []
              : [{ body: '<!-- leverframe:command-reply:delivery-1 -->', id: 77 }],
        };
      }
      if (route === 'POST /repos/{owner}/{repo}/issues/{issue_number}/comments') {
        postAttempts += 1;
        throw new Error('connection lost after GitHub accepted the comment');
      }
      throw new Error(`unexpected route: ${route}`);
    });

    const client = new GitHubAppClient({
      appId: 1,
      clientId: 'client',
      name: 'leverframe',
      privateKey: 'private-key',
      slug: 'leverframe',
      webhookSecret: 'secret',
    });
    const input = {
      body: 'Review queued.',
      deliveryId: 'delivery-1',
      installationId: 42,
      pullRequestNumber: 7,
      repository: 'example/project',
    };

    await expect(client.createCommandReply(input)).resolves.toBe(77);
    await expect(client.createCommandReply(input)).resolves.toBe(77);

    expect(postAttempts).toBe(1);
    expect(commentLookups).toBe(3);
  });
});

describe('review thread lifecycle', () => {
  it('associates only unambiguous markers from the published review', async () => {
    githubMocks.graphql.mockResolvedValue({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [
              {
                comments: {
                  nodes: [
                    {
                      body: '<!-- leverframe:finding:1234567890abcdef:job:7 -->',
                      id: 'comment-1',
                      pullRequestReview: { fullDatabaseId: '99' },
                    },
                  ],
                },
                id: 'thread-1',
                isResolved: false,
                viewerCanResolve: true,
              },
              {
                comments: {
                  nodes: [
                    {
                      body: '<!-- leverframe:finding:fedcba0987654321:job:8 -->',
                      id: 'comment-other-job',
                      pullRequestReview: { fullDatabaseId: '99' },
                    },
                  ],
                },
                id: 'thread-other-job',
                isResolved: false,
                viewerCanResolve: true,
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      },
    });
    const client = createClient();

    await expect(
      client.findPublishedFindingThreads({
        expectedFingerprints: new Set(['1234567890abcdef']),
        installationId: 42,
        jobId: 7,
        pullRequestNumber: 3,
        repository: 'example/project',
        reviewDatabaseId: 99,
      }),
    ).resolves.toEqual([
      {
        commentNodeId: 'comment-1',
        fingerprint: '1234567890abcdef',
        threadNodeId: 'thread-1',
      },
    ]);
  });

  it('reconciles an accepted reply before resolving the thread', async () => {
    githubMocks.installationRequest.mockResolvedValue({
      data: pullRequestResponse('b'.repeat(40)),
    });
    githubMocks.graphql
      .mockResolvedValueOnce({
        node: {
          comments: { nodes: [] },
          id: 'thread-1',
          isResolved: false,
          viewerCanResolve: true,
        },
      })
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({
        node: {
          comments: {
            nodes: [
              {
                body: '<!-- leverframe:resolution:1234567890abcdef:job:8 -->',
                id: 'resolution-comment',
              },
            ],
          },
          id: 'thread-1',
          isResolved: false,
          viewerCanResolve: true,
        },
      })
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { id: 'thread-1', isResolved: true } },
      });
    const client = createClient();

    await expect(
      client.resolveFindingThread({
        evidence: 'The condition is now correct.',
        expectedHeadSha: 'b'.repeat(40),
        fingerprint: '1234567890abcdef',
        installationId: 42,
        jobId: 8,
        pullRequestNumber: 3,
        repository: 'example/project',
        threadNodeId: 'thread-1',
      }),
    ).resolves.toEqual({
      alreadyResolved: false,
      resolutionCommentNodeId: 'resolution-comment',
    });
    expect(githubMocks.graphql).toHaveBeenCalledTimes(4);
  });

  it('attempts the mutation when an installation token reports viewerCanResolve false', async () => {
    githubMocks.installationRequest.mockResolvedValue({
      data: pullRequestResponse('b'.repeat(40)),
    });
    githubMocks.graphql
      .mockResolvedValueOnce({
        node: {
          comments: { nodes: [] },
          id: 'thread-1',
          isResolved: false,
          viewerCanResolve: false,
        },
      })
      .mockResolvedValueOnce({
        addPullRequestReviewThreadReply: { comment: { id: 'resolution-comment' } },
      })
      .mockResolvedValueOnce({
        resolveReviewThread: { thread: { id: 'thread-1', isResolved: true } },
      });
    const client = createClient();

    await expect(
      client.resolveFindingThread({
        evidence: 'The condition is now correct.',
        expectedHeadSha: 'b'.repeat(40),
        fingerprint: '1234567890abcdef',
        installationId: 42,
        jobId: 8,
        pullRequestNumber: 3,
        repository: 'example/project',
        threadNodeId: 'thread-1',
      }),
    ).resolves.toEqual({
      alreadyResolved: false,
      resolutionCommentNodeId: 'resolution-comment',
    });
    expect(githubMocks.graphql).toHaveBeenCalledTimes(3);
  });

  it('rejects a successful reply mutation with no persisted comment', async () => {
    githubMocks.installationRequest.mockResolvedValue({
      data: pullRequestResponse('b'.repeat(40)),
    });
    githubMocks.graphql
      .mockResolvedValueOnce({
        node: {
          comments: { nodes: [] },
          id: 'thread-1',
          isResolved: false,
          viewerCanResolve: true,
        },
      })
      .mockResolvedValueOnce({ addPullRequestReviewThreadReply: null })
      .mockResolvedValueOnce({
        node: {
          comments: { nodes: [] },
          id: 'thread-1',
          isResolved: false,
          viewerCanResolve: true,
        },
      });

    await expect(resolveThread(createClient())).rejects.toMatchObject({ retryable: true });
    expect(githubMocks.graphql).toHaveBeenCalledTimes(3);
  });

  it('rejects a successful resolve mutation that does not resolve the thread', async () => {
    githubMocks.installationRequest.mockResolvedValue({
      data: pullRequestResponse('b'.repeat(40)),
    });
    const unresolvedThread = {
      node: {
        comments: { nodes: [] },
        id: 'thread-1',
        isResolved: false,
        viewerCanResolve: true,
      },
    };
    githubMocks.graphql
      .mockResolvedValueOnce(unresolvedThread)
      .mockResolvedValueOnce({
        addPullRequestReviewThreadReply: { comment: { id: 'resolution-comment' } },
      })
      .mockResolvedValueOnce({ resolveReviewThread: null })
      .mockResolvedValueOnce(unresolvedThread)
      .mockResolvedValueOnce(unresolvedThread);

    await expect(resolveThread(createClient())).rejects.toMatchObject({ retryable: true });
    expect(githubMocks.graphql).toHaveBeenCalledTimes(5);
  });
});

function resolveThread(client: GitHubReviewThreadClient) {
  return client.resolveFindingThread({
    evidence: 'The condition is now correct.',
    expectedHeadSha: 'b'.repeat(40),
    fingerprint: '1234567890abcdef',
    installationId: 42,
    jobId: 8,
    pullRequestNumber: 3,
    repository: 'example/project',
    threadNodeId: 'thread-1',
  });
}

function createClient(): GitHubReviewThreadClient {
  return new GitHubReviewThreadClient({
    appId: 1,
    clientId: 'client',
    name: 'leverframe',
    privateKey: 'private-key',
    slug: 'leverframe',
    webhookSecret: 'secret',
  });
}

function pullRequestResponse(headSha: string) {
  return {
    base: {
      ref: 'main',
      repo: { clone_url: 'https://github.com/example/project.git', default_branch: 'main', id: 1 },
      sha: 'a'.repeat(40),
    },
    draft: false,
    head: { sha: headSha },
    state: 'open',
    title: 'Test pull request',
  };
}
