import { App } from '@octokit/app';
import type { ReviewResult } from '../review/result.js';
import {
  commandReplyMarker,
  productName,
  reviewPublicationMarker,
  statusCommentMarker,
} from '../identity.js';
import {
  type ReviewInlineComment,
  findingResolutionMarker,
  parseFindingPublicationMarker,
} from '../review/publication.js';
import { renderReview } from '../review/result.js';
import type { GitHubAppCredentials } from './credentials.js';
import {
  addReviewThreadReplyMutation,
  resolveReviewThreadMutation,
  reviewThreadQuery,
  reviewThreadsQuery,
} from './review-thread-graphql.js';

const maximumGitHubBodyCharacters = 60_000;

export interface PullRequestDetails {
  baseRef: string;
  baseSha: string;
  cloneUrl: string;
  defaultBranch: string;
  draft: boolean;
  headSha: string;
  repositoryId: number;
  state: 'closed' | 'open';
  title: string;
}

export interface FindingContext {
  content: string;
  startLine: number;
  endLine: number;
}

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

export type CheckConclusion = 'cancelled' | 'failure' | 'neutral' | 'success' | 'timed_out';

export interface CheckOutput {
  summary: string;
  title: string;
}

export class GitHubAppClient {
  readonly #app: App;

  constructor(credentials: GitHubAppCredentials) {
    this.#app = new App({
      appId: credentials.appId,
      privateKey: credentials.privateKey,
    });
  }

  async getPullRequest(input: {
    installationId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<PullRequestDetails> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const response = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        pull_number: input.pullRequestNumber,
        repo: repository,
      }),
    );

    return {
      baseRef: response.data.base.ref,
      baseSha: response.data.base.sha,
      cloneUrl: response.data.base.repo.clone_url,
      defaultBranch: response.data.base.repo.default_branch,
      draft: response.data.draft ?? false,
      headSha: response.data.head.sha,
      repositoryId: Number(response.data.base.repo.id),
      state: response.data.state,
      title: response.data.title,
    };
  }

  async getRepositoryTextFile(input: {
    installationId: number;
    path: string;
    ref: string;
    repository: string;
  }): Promise<string | undefined> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    try {
      const response = await this.#withRetry(() =>
        octokit.request('GET /repos/{owner}/{repo}/contents/{path}', {
          owner,
          path: input.path,
          ref: input.ref,
          repo: repository,
        }),
      );
      if (Array.isArray(response.data) || !('content' in response.data)) {
        throw new Error(`repository policy path is not a file: ${input.path}`);
      }
      return Buffer.from(response.data.content, 'base64').toString('utf8');
    } catch (error) {
      if (githubErrorStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  /** Fetch only a bounded patch fragment from an immutable base/head comparison. */
  async getFindingContext(input: {
    installationId: number;
    repository: string;
    baseSha: string;
    headSha: string;
    file: string;
    line: number;
  }): Promise<FindingContext | undefined> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    try {
      const response = await this.#withRetry(() =>
        octokit.request('GET /repos/{owner}/{repo}/compare/{basehead}', {
          owner,
          repo: repository,
          basehead: `${input.baseSha}...${input.headSha}`,
        }),
      );
      const file = response.data.files?.find((candidate) => candidate.filename === input.file);
      if (file === undefined || typeof file.patch !== 'string') {
        return undefined;
      }
      const context = contextFromPatch(file.patch, input.line);
      return context;
    } catch (error) {
      if (githubErrorStatus(error) === 404) {
        return undefined;
      }
      throw error;
    }
  }

  async createRepositoryReadToken(input: {
    allowedOwnerId: number;
    installationId: number;
    repositoryId: number;
  }): Promise<string> {
    const installation = await this.#app.octokit.request(
      'GET /app/installations/{installation_id}',
      { installation_id: input.installationId },
    );
    if (
      installation.data.account === null ||
      installation.data.account.id !== input.allowedOwnerId
    ) {
      throw new Error(`installation ${input.installationId} is not owned by the allowed account`);
    }
    const response = await this.#app.octokit.request(
      'POST /app/installations/{installation_id}/access_tokens',
      repositoryReadTokenRequest(input.installationId, input.repositoryId),
    );
    return response.data.token;
  }

  async actorCanManagePullRequest(input: {
    actor: string;
    installationId: number;
    repository: string;
  }): Promise<boolean> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const response = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}/collaborators/{username}/permission', {
        owner,
        repo: repository,
        username: input.actor,
      }),
    );
    return canManageRepositoryRole(response.data.role_name ?? response.data.permission);
  }

  async createCommandReply(input: {
    body: string;
    deliveryId: string;
    installationId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const marker = commandReplyMarker(input.deliveryId);
    const existingId = await this.#findIssueComment({
      marker,
      octokit,
      owner,
      pullRequestNumber: input.pullRequestNumber,
      repository,
    });
    if (existingId !== undefined) {
      return existingId;
    }

    const body = bodyWithMarker(input.body, marker);
    try {
      const response = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          body,
          issue_number: input.pullRequestNumber,
          owner,
          repo: repository,
        },
      );
      return Number(response.data.id);
    } catch (error) {
      const reconciledId = await this.#findIssueComment({
        marker,
        octokit,
        owner,
        pullRequestNumber: input.pullRequestNumber,
        repository,
      });
      if (reconciledId !== undefined) {
        return reconciledId;
      }
      throw error;
    }
  }

  async createQueuedCheckRun(input: {
    headSha: string;
    installationId: number;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const externalId = `review-job:${input.jobId}`;
    const existingId = await this.#findCheckRun({
      externalId,
      headSha: input.headSha,
      octokit,
      owner,
      repository,
    });
    if (existingId !== undefined) {
      return existingId;
    }

    try {
      const response = await octokit.request('POST /repos/{owner}/{repo}/check-runs', {
        details_url: `https://github.com/${input.repository}/pull/${input.pullRequestNumber}`,
        external_id: externalId,
        head_sha: input.headSha,
        name: `${productName} / code review`,
        output: {
          summary: 'Waiting for the review worker to start.',
          title: 'Code review queued',
        },
        owner,
        repo: repository,
        status: 'queued',
      });
      return Number(response.data.id);
    } catch (error) {
      const reconciledId = await this.#findCheckRun({
        externalId,
        headSha: input.headSha,
        octokit,
        owner,
        repository,
      });
      if (reconciledId !== undefined) {
        return reconciledId;
      }
      throw error;
    }
  }

  async startCheckRun(input: {
    checkRunId: number;
    installationId: number;
    repository: string;
  }): Promise<void> {
    await this.#updateCheckRun({
      ...input,
      output: {
        summary: 'Preparing an isolated environment and running the Codex review.',
        title: 'Code review in progress',
      },
      status: 'in_progress',
    });
  }

  async createStatusComment(input: {
    body: string;
    installationId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const body = limitGitHubBody(input.body);
    try {
      const response = await octokit.request(
        'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
        {
          body,
          issue_number: input.pullRequestNumber,
          owner,
          repo: repository,
        },
      );
      return Number(response.data.id);
    } catch (error) {
      const reconciledId = await this.findStatusComment(input);
      if (reconciledId !== undefined) {
        return reconciledId;
      }
      throw error;
    }
  }

  async findStatusComment(input: {
    installationId: number;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number | undefined> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    return this.#findIssueComment({
      marker: statusCommentMarker(),
      octokit,
      owner,
      pullRequestNumber: input.pullRequestNumber,
      repository,
    });
  }

  async updateStatusComment(input: {
    body: string;
    commentId: number;
    installationId: number;
    repository: string;
  }): Promise<void> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    await this.#withRetry(() =>
      octokit.request('PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}', {
        body: limitGitHubBody(input.body),
        comment_id: input.commentId,
        owner,
        repo: repository,
      }),
    );
  }

  async completeCheckRun(input: {
    checkRunId: number;
    conclusion: CheckConclusion;
    detailsUrl?: string;
    installationId: number;
    output: CheckOutput;
    repository: string;
  }): Promise<void> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const detailsUrl = input.detailsUrl === undefined ? {} : { details_url: input.detailsUrl };
    await this.#withRetry(() =>
      octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
        check_run_id: input.checkRunId,
        completed_at: new Date().toISOString(),
        conclusion: input.conclusion,
        ...detailsUrl,
        output: input.output,
        owner,
        repo: repository,
        status: 'completed',
      }),
    );
  }

  async publishReview(input: {
    expectedHeadSha: string;
    installationId: number;
    inlineComments?: ReviewInlineComment[];
    inlineFindingIndexes?: ReadonlySet<number>;
    jobId: number;
    pullRequestNumber: number;
    repository: string;
    result: ReviewResult;
    signal: AbortSignal;
  }): Promise<number> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const pullRequest = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}', {
        owner,
        pull_number: input.pullRequestNumber,
        repo: repository,
      }),
    );
    if (pullRequest.data.head.sha !== input.expectedHeadSha) {
      throw new Error(
        `pull request head changed from ${input.expectedHeadSha} to ${pullRequest.data.head.sha}`,
      );
    }

    const marker = reviewPublicationMarker(input.jobId, input.expectedHeadSha);
    const existingId = await this.#findReview({
      marker,
      octokit,
      owner,
      pullRequestNumber: input.pullRequestNumber,
      repository,
    });
    if (existingId !== undefined) {
      return existingId;
    }

    const inlineComments = input.inlineComments ?? [];
    const body = bodyWithMarker(renderReview(input.result, input.inlineFindingIndexes), marker);
    input.signal.throwIfAborted();
    try {
      const review = await octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        {
          body,
          comments: inlineComments.map((comment) => ({
            body: limitGitHubBody(comment.body),
            line: comment.line,
            path: comment.path,
            side: 'RIGHT' as const,
          })),
          commit_id: input.expectedHeadSha,
          event: 'COMMENT',
          owner,
          pull_number: input.pullRequestNumber,
          request: { signal: input.signal },
          repo: repository,
        },
      );
      return Number(review.data.id);
    } catch (error) {
      const reconciledId = await this.#findReview({
        marker,
        octokit,
        owner,
        pullRequestNumber: input.pullRequestNumber,
        repository,
      });
      if (reconciledId !== undefined) {
        return reconciledId;
      }
      if (githubErrorStatus(error) === 422 && inlineComments.length > 0) {
        input.signal.throwIfAborted();
        return this.#publishSummaryFallback({
          body: bodyWithMarker(renderReview(input.result), marker),
          expectedHeadSha: input.expectedHeadSha,
          marker,
          octokit,
          owner,
          pullRequestNumber: input.pullRequestNumber,
          repository,
          signal: input.signal,
        });
      }
      throw error;
    }
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
        const response: ReviewThreadsQuery = await this.#withRetry(() =>
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
    const pullRequest = await this.getPullRequest(input);
    if (pullRequest.headSha !== input.expectedHeadSha) {
      throw new GitHubThreadResolutionError(
        `pull request head changed from ${input.expectedHeadSha} to ${pullRequest.headSha} before resolving review thread`,
        false,
      );
    }
    if (pullRequest.state !== 'open' || pullRequest.draft) {
      throw new GitHubThreadResolutionError(
        pullRequest.state !== 'open'
          ? 'pull request is no longer open before resolving review thread'
          : 'pull request is a draft before resolving review thread',
        false,
      );
    }
    input.signal?.throwIfAborted();
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const marker = findingResolutionMarker(input.jobId, input.fingerprint);
    let thread = await this.#getReviewThread(octokit, input.threadNodeId);
    if (thread.isResolved) {
      return { alreadyResolved: true };
    }
    if (!thread.viewerCanResolve) {
      throw new GitHubThreadResolutionError(
        `GitHub App cannot resolve review thread ${input.threadNodeId}`,
        false,
      );
    }

    let resolutionCommentNodeId = thread.comments.nodes?.find((comment) =>
      comment?.body.includes(marker),
    )?.id;
    if (resolutionCommentNodeId === undefined) {
      input.signal?.throwIfAborted();
      try {
        const reply = await octokit.graphql<AddReviewThreadReplyMutation>(
          addReviewThreadReplyMutation,
          {
            body: renderResolutionReply(input, marker),
            threadId: input.threadNodeId,
          },
        );
        resolutionCommentNodeId = reply.addPullRequestReviewThreadReply?.comment?.id;
      } catch (error) {
        thread = await this.#getReviewThread(octokit, input.threadNodeId);
        resolutionCommentNodeId = thread.comments.nodes?.find((comment) =>
          comment?.body.includes(marker),
        )?.id;
        if (resolutionCommentNodeId === undefined) {
          throw asThreadResolutionError(error);
        }
      }
    }

    input.signal?.throwIfAborted();
    try {
      await octokit.graphql<ResolveReviewThreadMutation>(resolveReviewThreadMutation, {
        threadId: input.threadNodeId,
      });
    } catch (error) {
      thread = await this.#getReviewThread(octokit, input.threadNodeId);
      if (!thread.isResolved) {
        throw asThreadResolutionError(error);
      }
    }
    return {
      alreadyResolved: false,
      ...(resolutionCommentNodeId === undefined ? {} : { resolutionCommentNodeId }),
    };
  }

  async #findIssueComment(input: {
    marker: string;
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>;
    owner: string;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number | undefined> {
    for (let page = 1; ; page += 1) {
      const response = await this.#withRetry(() =>
        input.octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}/comments', {
          issue_number: input.pullRequestNumber,
          owner: input.owner,
          page,
          per_page: 100,
          repo: input.repository,
        }),
      );
      const comment = response.data.find((candidate) => candidate.body?.includes(input.marker));
      if (comment !== undefined) {
        return Number(comment.id);
      }
      if (response.data.length < 100) {
        return undefined;
      }
    }
  }

  async #getReviewThread(
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>,
    threadNodeId: string,
  ): Promise<ReviewThreadNode> {
    const comments: Array<ReviewCommentNode | null> = [];
    let after: string | undefined;
    let thread: ReviewThreadNode | undefined;
    do {
      const response = await this.#withRetry(() =>
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

  async #updateCheckRun(input: {
    checkRunId: number;
    installationId: number;
    output: CheckOutput;
    repository: string;
    status: 'in_progress';
  }): Promise<void> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    await this.#withRetry(() =>
      octokit.request('PATCH /repos/{owner}/{repo}/check-runs/{check_run_id}', {
        check_run_id: input.checkRunId,
        output: input.output,
        owner,
        repo: repository,
        started_at: new Date().toISOString(),
        status: input.status,
      }),
    );
  }

  async #findCheckRun(input: {
    externalId: string;
    headSha: string;
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>;
    owner: string;
    repository: string;
  }): Promise<number | undefined> {
    for (let page = 1; ; page += 1) {
      const response = await this.#withRetry(() =>
        input.octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
          owner: input.owner,
          page,
          per_page: 100,
          ref: input.headSha,
          repo: input.repository,
        }),
      );
      const checkRun = response.data.check_runs.find(
        (candidate) => candidate.external_id === input.externalId,
      );
      if (checkRun !== undefined) {
        return Number(checkRun.id);
      }
      if (response.data.check_runs.length < 100) {
        return undefined;
      }
    }
  }

  async #findReview(input: {
    marker: string;
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>;
    owner: string;
    pullRequestNumber: number;
    repository: string;
  }): Promise<number | undefined> {
    for (let page = 1; ; page += 1) {
      const response = await this.#withRetry(() =>
        input.octokit.request('GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews', {
          owner: input.owner,
          page,
          per_page: 100,
          pull_number: input.pullRequestNumber,
          repo: input.repository,
        }),
      );
      const review = response.data.find((candidate) => candidate.body?.includes(input.marker));
      if (review !== undefined) {
        return Number(review.id);
      }
      if (response.data.length < 100) {
        return undefined;
      }
    }
  }

  async #publishSummaryFallback(input: {
    body: string;
    expectedHeadSha: string;
    marker: string;
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>;
    owner: string;
    pullRequestNumber: number;
    repository: string;
    signal: AbortSignal;
  }): Promise<number> {
    input.signal.throwIfAborted();
    try {
      const review = await input.octokit.request(
        'POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews',
        {
          body: input.body,
          commit_id: input.expectedHeadSha,
          event: 'COMMENT',
          owner: input.owner,
          pull_number: input.pullRequestNumber,
          request: { signal: input.signal },
          repo: input.repository,
        },
      );
      return Number(review.data.id);
    } catch (error) {
      const reconciledId = await this.#findReview(input);
      if (reconciledId !== undefined) {
        return reconciledId;
      }
      throw error;
    }
  }

  async #withRetry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        const delayMilliseconds = githubRetryDelayMilliseconds(error, attempt);
        if (delayMilliseconds === undefined || attempt >= 2) {
          throw error;
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delayMilliseconds);
        });
      }
    }
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

function contextFromPatch(patch: string, targetLine: number): FindingContext | undefined {
  const lines = patch.split('\n');
  let newLine = 0;
  let hunk: Array<{ line: number; text: string }> = [];
  let targetHunk: Array<{ line: number; text: string }> | undefined;
  for (const line of lines) {
    const header = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header !== null) {
      newLine = Number(header[1]);
      hunk = [];
      continue;
    }
    if (newLine === 0) {
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      hunk.push({ line: newLine, text: line });
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      hunk.push({ line: newLine, text: line });
      if (newLine === targetLine) {
        targetHunk = hunk;
      }
      newLine += 1;
      continue;
    }
    hunk.push({ line: newLine, text: line });
    if (newLine === targetLine) {
      targetHunk = hunk;
    }
    newLine += 1;
  }
  if (targetHunk === undefined) {
    return undefined;
  }
  const startLine = Math.max(1, targetLine - 20);
  const endLine = targetLine + 20;
  const selected = targetHunk.filter((item) => item.line >= startLine && item.line <= endLine);
  if (selected.length === 0) {
    return undefined;
  }
  return {
    content: selected
      .map((item) => `${item.line}: ${item.text}`)
      .join('\n')
      .slice(0, 16_384),
    startLine: selected[0]?.line ?? targetLine,
    endLine: selected.at(-1)?.line ?? targetLine,
  };
}

export function repositoryReadTokenRequest(installationId: number, repositoryId: number) {
  return {
    installation_id: installationId,
    permissions: { contents: 'read' as const },
    repository_ids: [repositoryId],
  };
}

export function limitGitHubBody(
  value: string,
  maximumCharacters = maximumGitHubBodyCharacters,
): string {
  if (value.length <= maximumCharacters) {
    return value;
  }
  const notice = '\n\n_Review output was truncated to fit GitHub limits._';
  if (notice.length >= maximumCharacters) {
    return notice.slice(0, maximumCharacters);
  }
  return `${value.slice(0, Math.max(0, maximumCharacters - notice.length))}${notice}`;
}

export function githubRetryDelayMilliseconds(error: unknown, attempt: number): number | undefined {
  const record = asRecord(error);
  const response = asRecord(record?.response);
  const headers = asRecord(response?.headers);
  const status = typeof record?.status === 'number' ? record.status : undefined;
  const retryAfterSeconds = numericHeader(headers?.['retry-after']);
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return Math.min(
      30_000,
      retryAfterSeconds === undefined ? 500 * 2 ** attempt : retryAfterSeconds * 1_000,
    );
  }
  if (
    status === 403 &&
    (retryAfterSeconds !== undefined || String(headers?.['x-ratelimit-remaining']) === '0')
  ) {
    const resetAtSeconds = numericHeader(headers?.['x-ratelimit-reset']);
    const resetDelay =
      resetAtSeconds === undefined ? undefined : resetAtSeconds * 1_000 - Date.now();
    return Math.min(
      30_000,
      Math.max(
        0,
        retryAfterSeconds === undefined
          ? (resetDelay ?? 1_000 * 2 ** attempt)
          : retryAfterSeconds * 1_000,
      ),
    );
  }

  const code = typeof record?.code === 'string' ? record.code : undefined;
  return code !== undefined && ['EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT'].includes(code)
    ? 500 * 2 ** attempt
    : undefined;
}

export function canManageRepositoryRole(role: string): boolean {
  return ['admin', 'maintain', 'triage', 'write'].includes(role);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function numericHeader(value: unknown): number | undefined {
  const parsed =
    typeof value === 'string' || typeof value === 'number' ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function githubErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  return typeof record?.status === 'number' ? record.status : undefined;
}

function bodyWithMarker(body: string, marker: string): string {
  const suffix = `\n\n${marker}`;
  return `${limitGitHubBody(body, maximumGitHubBodyCharacters - suffix.length)}${suffix}`;
}

function splitRepository(value: string): [string, string] {
  const [owner, repository, ...rest] = value.split('/');
  if (owner === undefined || repository === undefined || rest.length > 0) {
    throw new Error(`invalid repository: ${value}`);
  }
  return [owner, repository];
}
