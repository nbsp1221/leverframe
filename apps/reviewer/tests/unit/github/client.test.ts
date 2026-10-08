import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    expect(githubRetryDelayMilliseconds({ status: 404 }, 0)).toBeUndefined();
    expect(githubRetryDelayMilliseconds({ status: 422 }, 0)).toBeUndefined();
  });
});

describe('Check Run start recovery', () => {
  const input = { checkRunId: 101, installationId: 42, repository: 'example/project' };
  const route = 'PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}';

  beforeEach(() => {
    githubMocks.installationRequest.mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    githubMocks.installationRequest.mockReset();
  });

  it('waits 1s and 2s for start-only 404s and continues once with the same request', async () => {
    githubMocks.installationRequest
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }))
      .mockRejectedValueOnce(Object.assign(new Error('missing'), { status: 404 }))
      .mockResolvedValueOnce({ data: {} });
    const continueReview = vi.fn();
    const pending = createAppClient().startCheckRun(input).then(continueReview);

    await vi.advanceTimersByTimeAsync(999);
    expect(githubMocks.installationRequest).toHaveBeenCalledTimes(1);
    expect(continueReview).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(githubMocks.installationRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(githubMocks.installationRequest).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    await pending;

    expect(githubMocks.installationRequest).toHaveBeenCalledTimes(3);
    expect(continueReview).toHaveBeenCalledOnce();
    const parameters: unknown = githubMocks.installationRequest.mock.calls[0]?.[1];
    expect(parameters).toMatchObject({
      check_run_id: 101,
      owner: 'example',
      repo: 'project',
      started_at: '2026-01-01T00:00:00.000Z',
      status: 'in_progress',
    });
    for (const call of githubMocks.installationRequest.mock.calls) {
      expect(call[0]).toBe(route);
      expect(call[1]).toBe(parameters);
    }
  });

  it('stops after three persistent 404s and records safe diagnostics for every attempt', async () => {
    const error = Object.assign(new Error('secret error body'), {
      request: { headers: { authorization: 'secret-auth' }, url: 'secret-url' },
      response: {
        data: { secret: 'secret-response' },
        headers: { 'x-github-request-id': 'ABCD:1234:5678', 'set-cookie': 'secret-cookie' },
      },
      status: 404,
    });
    githubMocks.installationRequest.mockRejectedValue(error);
    const continueReview = vi.fn();
    const pending = expect(
      createAppClient().startCheckRun(input).then(continueReview),
    ).rejects.toBe(error);
    await vi.runAllTimersAsync();
    await pending;

    expect(githubMocks.installationRequest).toHaveBeenCalledTimes(3);
    expect(continueReview).not.toHaveBeenCalled();
    const logs = vi
      .mocked(console.warn)
      .mock.calls.map(([line]) => JSON.parse(String(line)) as unknown);
    expect(logs).toEqual(
      [0, 1, 3].map((seconds, index) => ({
        event: 'github_check_run_start_failed',
        attempt: index + 1,
        checkRunId: 101,
        requestId: 'ABCD:1234:5678',
        route,
        status: 404,
        timestamp: `2026-01-01T00:00:0${seconds}.000Z`,
      })),
    );
    expect(JSON.stringify(logs)).not.toContain('secret');
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([401, 403, 422])('does not retry a permanent %i error', async (status) => {
    const error = Object.assign(new Error('permanent'), { status });
    githubMocks.installationRequest.mockRejectedValue(error);
    await expect(createAppClient().startCheckRun(input)).rejects.toBe(error);
    expect(githubMocks.installationRequest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0]))).toMatchObject({
      requestId: null,
      status,
    });
  });

  it('repeats the same status update after a lost response without starting another retry budget', async () => {
    let startRequests = 0;
    githubMocks.installationRequest.mockImplementation(() => {
      startRequests += 1;
      if (startRequests === 1) {
        return Promise.reject(Object.assign(new Error('response lost'), { code: 'ECONNRESET' }));
      }
      if (startRequests === 2) {
        return Promise.reject(Object.assign(new Error('missing'), { status: 404 }));
      }
      return Promise.resolve({ data: {} });
    });
    const pending = createAppClient().startCheckRun(input);
    await vi.advanceTimersByTimeAsync(499);
    expect(startRequests).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(startRequests).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(startRequests).toBe(3);
    const first: unknown = githubMocks.installationRequest.mock.calls[0]?.[1];
    expect(githubMocks.installationRequest.mock.calls.every((call) => call[1] === first)).toBe(
      true,
    );
  });

  it('omits malformed request IDs from diagnostics', async () => {
    githubMocks.installationRequest.mockRejectedValue(
      Object.assign(new Error('invalid'), {
        response: { headers: { 'x-github-request-id': 'unsafe\nheader' } },
        status: 422,
      }),
    );
    await expect(createAppClient().startCheckRun(input)).rejects.toThrow('invalid');
    expect(JSON.parse(String(vi.mocked(console.warn).mock.calls[0]?.[0])) as unknown).toMatchObject(
      {
        requestId: null,
      },
    );
  });

  it('does not extend 404 retries to Check Run completion', async () => {
    const error = Object.assign(new Error('missing'), { status: 404 });
    githubMocks.installationRequest.mockRejectedValue(error);
    await expect(
      createAppClient().completeCheckRun({
        ...input,
        conclusion: 'success',
        output: { summary: 'No defects', title: 'Review complete' },
      }),
    ).rejects.toBe(error);
    expect(githubMocks.installationRequest).toHaveBeenCalledOnce();
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe('development repository catalog', () => {
  it('lists only active installations for the allowed owner and sorts repositories', async () => {
    githubMocks.appRequest.mockResolvedValueOnce({
      data: [
        { account: { id: 7 }, id: 41, suspended_at: null },
        { account: { id: 8 }, id: 42, suspended_at: null },
        { account: { id: 7 }, id: 43, suspended_at: '2026-08-30T00:00:00Z' },
      ],
    });
    githubMocks.installationRequest.mockResolvedValueOnce({
      data: {
        repositories: [
          { default_branch: 'main', full_name: 'owner/zeta', id: 2, private: true },
          { default_branch: 'trunk', full_name: 'owner/alpha', id: 1, private: false },
        ],
      },
    });

    await expect(createAppClient().listRepositories(7)).resolves.toEqual([
      { defaultBranch: 'trunk', private: false, repository: 'owner/alpha' },
      { defaultBranch: 'main', private: true, repository: 'owner/zeta' },
    ]);
    expect(githubMocks.getInstallationOctokit).toHaveBeenCalledTimes(1);
    expect(githubMocks.getInstallationOctokit).toHaveBeenCalledWith(41);
  });

  it('requires an exact active repository installation before resolving checkout facts', async () => {
    githubMocks.appRequest.mockResolvedValueOnce({
      data: { account: { id: 7 }, id: 41, suspended_at: null },
    });
    githubMocks.installationRequest
      .mockResolvedValueOnce({
        data: {
          clone_url: 'https://github.com/owner/project.git',
          default_branch: 'main',
          full_name: 'owner/project',
          id: 9,
          owner: { id: 7 },
        },
      })
      .mockResolvedValueOnce({ data: { commit: { sha: 'a'.repeat(40) } } });

    await expect(
      createAppClient().getRepository({ allowedOwnerId: 7, repository: 'owner/project' }),
    ).resolves.toEqual({
      cloneUrl: 'https://github.com/owner/project.git',
      defaultBranch: 'main',
      defaultBranchSha: 'a'.repeat(40),
      installationId: 41,
      repositoryId: 9,
    });
    expect(githubMocks.appRequest).toHaveBeenCalledWith('GET /repos/{owner}/{repo}/installation', {
      owner: 'owner',
      repo: 'project',
    });
  });

  it('rejects a repository installed for a different owner before requesting repository data', async () => {
    githubMocks.appRequest.mockResolvedValueOnce({
      data: { account: { id: 8 }, id: 41, suspended_at: null },
    });

    await expect(
      createAppClient().getRepository({ allowedOwnerId: 7, repository: 'owner/project' }),
    ).rejects.toThrow('not accessible to the GitHub App');
    expect(githubMocks.getInstallationOctokit).not.toHaveBeenCalled();
  });

  it('rejects a repository renamed after catalog selection', async () => {
    githubMocks.appRequest.mockResolvedValueOnce({
      data: { account: { id: 7 }, id: 41, suspended_at: null },
    });
    githubMocks.installationRequest.mockResolvedValueOnce({
      data: {
        clone_url: 'https://github.com/owner/renamed.git',
        default_branch: 'main',
        full_name: 'owner/renamed',
        id: 9,
        owner: { id: 7 },
      },
    });

    await expect(
      createAppClient().resolveRepository({
        allowedOwnerId: 7,
        repository: 'owner/project',
      }),
    ).resolves.toBeUndefined();
  });

  it('reports an exact missing installation as inaccessible', async () => {
    githubMocks.appRequest.mockRejectedValueOnce(
      Object.assign(new Error('Not Found'), { status: 404 }),
    );

    await expect(
      createAppClient().isRepositoryAccessible({
        allowedOwnerId: 7,
        repository: 'owner/public-but-not-installed',
      }),
    ).resolves.toBe(false);
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

function createAppClient(): GitHubAppClient {
  return new GitHubAppClient({
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
