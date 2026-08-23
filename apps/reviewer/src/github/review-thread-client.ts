import { App } from '@octokit/app';
import { findingResolutionMarker, parseFindingPublicationMarker } from '../review/publication.js';
import type { GitHubAppCredentials } from './credentials.js';
import { githubRetryDelayMilliseconds, withGitHubRetry } from './retry.js';
import {
  addReviewThreadReplyMutation,
  resolveReviewThreadMutation,
  reviewThreadQuery,
  reviewThreadsQuery,
} from './review-thread-graphql.js';

export interface PublishedFindingThread {
  commentNodeId: string;
  fingerprint: string;
  threadNodeId: string;
}

export interface FindingThreadResolutionResult {
  alreadyResolved: boolean;
  resolutionCommentNodeId?: string;
}

export class GitHubThreadResolutionError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'GitHubThreadResolutionError';
  }
}

export class GitHubReviewThreadClient {
  readonly #app: App;

  constructor(credentials: GitHubAppCredentials) {
    this.#app = new App({ appId: credentials.appId, privateKey: credentials.privateKey });
  }

  async findPublishedFindingThreads(input: {
    expectedFingerprints: ReadonlySet<string>;
    installationId: number;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    reviewDatabaseId: number;
  }): Promise<PublishedFindingThread[]> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const candidates = new Map<string, PublishedFindingThread[]>();
      let after: string | undefined;
      do {
        const response = await withGitHubRetry(() =>
          octokit.graphql<ReviewThreadsQuery>(reviewThreadsQuery, {
            after: after ?? null,
            owner,
            pullRequestNumber: input.pullRequestNumber,
            repository,
          }),
        );
        const connection = response.repository?.pullRequest?.reviewThreads;
        if (connection === undefined || connection === null) {
          throw new Error(
            `pull request not found while locating review threads: ${input.repository}#${input.pullRequestNumber}`,
          );
        }
        for (const thread of connection.nodes ?? []) {
          if (thread === null) {
            continue;
          }
          for (const comment of thread.comments.nodes ?? []) {
            if (
              comment === null ||
              String(comment.pullRequestReview?.fullDatabaseId) !== String(input.reviewDatabaseId)
            ) {
              continue;
            }
            const marker = parseFindingPublicationMarker(comment.body);
            if (
              marker === undefined ||
              marker.jobId !== input.jobId ||
              !input.expectedFingerprints.has(marker.fingerprint)
            ) {
              continue;
            }
            const matches = candidates.get(marker.fingerprint) ?? [];
            matches.push({
              commentNodeId: comment.id,
              fingerprint: marker.fingerprint,
              threadNodeId: thread.id,
            });
            candidates.set(marker.fingerprint, matches);
          }
        }
        after = connection.pageInfo.hasNextPage
          ? (connection.pageInfo.endCursor ?? undefined)
          : undefined;
      } while (after !== undefined);

      const associations = [...candidates.values()].flatMap((matches) =>
        matches.length === 1 ? matches : [],
      );
      if (associations.length === input.expectedFingerprints.size || attempt === 2) {
        return associations;
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250 * 2 ** attempt);
      });
    }
    return [];
  }

  async resolveFindingThread(input: {
    evidence: string;
    expectedHeadSha: string;
    fingerprint: string;
    installationId: number;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    signal?: AbortSignal;
    threadNodeId: string;
  }): Promise<FindingThreadResolutionResult> {
    input.signal?.throwIfAborted();
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    let pullRequest;
    try {
      pullRequest = await withGitHubRetry(() =>
        octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
          owner,
          pull_number: input.pullRequestNumber,
          repo: repository,
        }),
      );
    } catch (error) {
      throw asThreadResolutionError(error);
    }
    if (pullRequest.data.head.sha !== input.expectedHeadSha) {
      throw new GitHubThreadResolutionError(
        `pull request head changed from ${input.expectedHeadSha} to ${pullRequest.data.head.sha} before resolving review thread`,
        false,
      );
    }
    if (pullRequest.data.state !== 'open' || pullRequest.data.draft) {
      throw new GitHubThreadResolutionError(
        pullRequest.data.state !== 'open'
          ? 'pull request is no longer open before resolving review thread'
          : 'pull request is a draft before resolving review thread',
        false,
      );
    }

    input.signal?.throwIfAborted();
    const marker = findingResolutionMarker(input.jobId, input.fingerprint);
    let thread = await this.#getReviewThread(octokit, input.threadNodeId);
    if (thread.isResolved) {
      return { alreadyResolved: true };
    }

    let resolutionCommentNodeId = findCommentByMarker(thread, marker);
    if (resolutionCommentNodeId === undefined) {
      input.signal?.throwIfAborted();
      try {
        const reply = await octokit.graphql<AddReviewThreadReplyMutation>(
          addReviewThreadReplyMutation,
          { body: renderResolutionReply(input, marker), threadId: input.threadNodeId },
        );
        resolutionCommentNodeId = reply.addPullRequestReviewThreadReply?.comment?.id;
      } catch (error) {
        thread = await this.#getReviewThread(octokit, input.threadNodeId);
        resolutionCommentNodeId = findCommentByMarker(thread, marker);
        if (resolutionCommentNodeId === undefined) {
          throw asThreadResolutionError(error);
        }
      }
      if (resolutionCommentNodeId === undefined) {
        thread = await this.#getReviewThread(octokit, input.threadNodeId);
        resolutionCommentNodeId = findCommentByMarker(thread, marker);
        if (resolutionCommentNodeId === undefined) {
          throw new GitHubThreadResolutionError(
            'GitHub did not return or persist the resolution reply',
            true,
          );
        }
      }
    }

    input.signal?.throwIfAborted();
    try {
      const response = await octokit.graphql<ResolveReviewThreadMutation>(
        resolveReviewThreadMutation,
        { threadId: input.threadNodeId },
      );
      const resolved = response.resolveReviewThread?.thread;
      if (resolved?.id !== input.threadNodeId || !resolved.isResolved) {
        thread = await this.#getReviewThread(octokit, input.threadNodeId);
        if (!thread.isResolved) {
          throw new GitHubThreadResolutionError(
            'GitHub returned an invalid resolveReviewThread payload',
            true,
          );
        }
      }
    } catch (error) {
      thread = await this.#getReviewThread(octokit, input.threadNodeId);
      if (!thread.isResolved) {
        throw asThreadResolutionError(error);
      }
    }
    return { alreadyResolved: false, resolutionCommentNodeId };
  }

  async #getReviewThread(
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>,
    threadNodeId: string,
  ): Promise<ReviewThreadNode> {
    const comments: Array<ReviewCommentNode | null> = [];
    let after: string | undefined;
    let thread: ReviewThreadNode | undefined;
    do {
      const response = await withGitHubRetry(() =>
        octokit.graphql<ReviewThreadQuery>(reviewThreadQuery, {
          after: after ?? null,
          threadId: threadNodeId,
        }),
      );
      if (response.node === null || response.node === undefined) {
        throw new GitHubThreadResolutionError(`review thread ${threadNodeId} was not found`, false);
      }
      thread = response.node;
      comments.push(...(thread.comments.nodes ?? []));
      after = thread.comments.pageInfo?.hasNextPage
        ? (thread.comments.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (after !== undefined);
    return { ...thread, comments: { nodes: comments } };
  }
}

interface ReviewCommentNode {
  body: string;
  id: string;
  pullRequestReview?: { fullDatabaseId: number | string } | null;
}

interface ReviewThreadNode {
  comments: {
    nodes?: Array<ReviewCommentNode | null> | null;
    pageInfo?: { endCursor?: string | null; hasNextPage: boolean };
  };
  id: string;
  isResolved: boolean;
  viewerCanResolve: boolean;
}

interface ReviewThreadsQuery {
  repository?: {
    pullRequest?: {
      reviewThreads: {
        nodes?: Array<ReviewThreadNode | null> | null;
        pageInfo: { endCursor?: string | null; hasNextPage: boolean };
      };
    } | null;
  } | null;
}

interface ReviewThreadQuery {
  node?: ReviewThreadNode | null;
}

interface AddReviewThreadReplyMutation {
  addPullRequestReviewThreadReply?: { comment?: { id: string } | null } | null;
}

interface ResolveReviewThreadMutation {
  resolveReviewThread?: { thread?: { id: string; isResolved: boolean } | null } | null;
}

function findCommentByMarker(thread: ReviewThreadNode, marker: string): string | undefined {
  return thread.comments.nodes?.find((comment) => comment?.body.includes(marker))?.id;
}

function renderResolutionReply(
  input: { evidence: string; expectedHeadSha: string },
  marker: string,
): string {
  return [
    `Leverframe verified this finding is fixed in \`${input.expectedHeadSha.slice(0, 12)}\`.`,
    '',
    `**Evidence:** ${input.evidence}`,
    '',
    marker,
  ].join('\n');
}

function asThreadResolutionError(error: unknown): GitHubThreadResolutionError {
  if (error instanceof GitHubThreadResolutionError) {
    return error;
  }
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubThreadResolutionError(
    message,
    githubRetryDelayMilliseconds(error, 0) !== undefined,
  );
}

function splitRepository(value: string): [string, string] {
  const [owner, repository, ...rest] = value.split('/');
  if (owner === undefined || repository === undefined || rest.length > 0) {
    throw new Error(`invalid repository: ${value}`);
  }
  return [owner, repository];
}
