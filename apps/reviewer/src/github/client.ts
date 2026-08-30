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
  findingPublicationMarker,
  parseFindingPublicationMarker,
} from '../review/publication.js';
import { renderReview } from '../review/result.js';
import type { GitHubAppCredentials } from './credentials.js';
import { withGitHubRetry } from './retry.js';

const maximumGitHubBodyCharacters = 60_000;
const githubPageSize = 100;
const maximumGitHubPages = 100;

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

export interface ReviewPublicationResult {
  publishedInlineFingerprints: readonly string[];
  reviewId: number;
}

export interface RepositoryDetails {
  cloneUrl: string;
  defaultBranch: string;
  defaultBranchSha: string;
  installationId: number;
  repositoryId: number;
}

export interface AppRepositorySummary {
  defaultBranch: string;
  private: boolean;
  repository: string;
}

export interface DevelopmentPullRequest {
  headSha: string;
  number: number;
  state: 'open';
  url: string;
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

  async getRepository(input: {
    allowedOwnerId: number;
    repository: string;
  }): Promise<RepositoryDetails> {
    const [owner, repository] = splitRepository(input.repository);
    const installation = await this.#withRetry(() =>
      this.#app.octokit.request('GET /repos/{owner}/{repo}/installation', {
        owner,
        repo: repository,
      }),
    );
    if (
      installation.data.account?.id !== input.allowedOwnerId ||
      installation.data.suspended_at !== null
    ) {
      throw new Error(`repository ${input.repository} is not accessible to the GitHub App`);
    }
    const octokit = await this.#app.getInstallationOctokit(installation.data.id);
    const response = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}', { owner, repo: repository }),
    );
    const branch = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
        owner,
        repo: repository,
        branch: response.data.default_branch,
      }),
    );
    return {
      cloneUrl: response.data.clone_url,
      defaultBranch: response.data.default_branch,
      defaultBranchSha: branch.data.commit.sha,
      installationId: Number(installation.data.id),
      repositoryId: Number(response.data.id),
    };
  }

  async isRepositoryAccessible(input: {
    allowedOwnerId: number;
    repository: string;
  }): Promise<boolean> {
    const [owner, repository] = splitRepository(input.repository);
    try {
      const installation = await this.#withRetry(() =>
        this.#app.octokit.request('GET /repos/{owner}/{repo}/installation', {
          owner,
          repo: repository,
        }),
      );
      return (
        installation.data.account?.id === input.allowedOwnerId &&
        installation.data.suspended_at === null
      );
    } catch (error) {
      if (githubErrorStatus(error) === 404) {
        return false;
      }
      throw error;
    }
  }

  async listRepositories(allowedOwnerId: number): Promise<readonly AppRepositorySummary[]> {
    const installations = await this.#allPages(async (page) => {
      const response = await this.#withRetry(() =>
        this.#app.octokit.request('GET /app/installations', {
          page,
          per_page: githubPageSize,
        }),
      );
      return response.data;
    });
    const repositories = new Map<number, AppRepositorySummary>();
    for (const installation of installations) {
      if (installation.account?.id !== allowedOwnerId || installation.suspended_at !== null) {
        continue;
      }
      const octokit = await this.#app.getInstallationOctokit(installation.id);
      const accessible = await this.#allPages(async (page) => {
        const response = await this.#withRetry(() =>
          octokit.request('GET /installation/repositories', {
            page,
            per_page: githubPageSize,
          }),
        );
        return response.data.repositories;
      });
      for (const repository of accessible) {
        const id = Number(repository.id);
        const summary = {
          defaultBranch: repository.default_branch,
          private: repository.private,
          repository: repository.full_name,
        };
        const existing = repositories.get(id);
        if (existing !== undefined && existing.repository !== summary.repository) {
          throw new Error(`GitHub repository ${id} has conflicting identities`);
        }
        repositories.set(id, summary);
      }
    }
    return [...repositories.values()].sort((left, right) =>
      left.repository.localeCompare(right.repository),
    );
  }

  async #allPages<T>(readPage: (page: number) => Promise<readonly T[]>): Promise<T[]> {
    const values: T[] = [];
    for (let page = 1; page <= maximumGitHubPages; page += 1) {
      const current = await readPage(page);
      values.push(...current);
      if (current.length < githubPageSize) {
        return values;
      }
    }
    throw new Error(`GitHub pagination exceeded ${maximumGitHubPages} pages`);
  }

  async findOpenPullRequest(input: {
    installationId: number;
    repository: string;
    branch: string;
  }): Promise<DevelopmentPullRequest | undefined> {
    const [owner, repository] = splitRepository(input.repository);
    const octokit = await this.#app.getInstallationOctokit(input.installationId);
    const response = await this.#withRetry(() =>
      octokit.request('GET /repos/{owner}/{repo}/pulls', {
        owner,
        repo: repository,
        state: 'open',
        head: `${owner}:${input.branch}`,
        per_page: 2,
      }),
    );
    if (response.data.length > 1) {
      throw new Error(`multiple open pull requests exist for ${input.repository}:${input.branch}`);
    }
    const pullRequest = response.data[0];
    return pullRequest === undefined
      ? undefined
      : {
          headSha: pullRequest.head.sha,
          number: Number(pullRequest.number),
          state: 'open',
          url: pullRequest.html_url,
        };
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
    knownReviewId?: number;
  }): Promise<ReviewPublicationResult> {
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
    const expectedFingerprints = new Set(
      (input.inlineComments ?? []).map((comment) => comment.fingerprint),
    );
    if (input.knownReviewId !== undefined) {
      return {
        publishedInlineFingerprints: await this.#findPublishedInlineFingerprints({
          expectedFingerprints,
          jobId: input.jobId,
          octokit,
          owner,
          pullRequestNumber: input.pullRequestNumber,
          repository,
          reviewId: input.knownReviewId,
        }),
        reviewId: input.knownReviewId,
      };
    }
    const existingId = await this.#findReview({
      marker,
      octokit,
      owner,
      pullRequestNumber: input.pullRequestNumber,
      repository,
    });
    if (existingId !== undefined) {
      return {
        publishedInlineFingerprints: await this.#findPublishedInlineFingerprints({
          expectedFingerprints,
          jobId: input.jobId,
          octokit,
          owner,
          pullRequestNumber: input.pullRequestNumber,
          repository,
          reviewId: existingId,
        }),
        reviewId: existingId,
      };
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
            body: renderMarkedInlineBody(comment, input.jobId),
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
      return {
        publishedInlineFingerprints: [...expectedFingerprints],
        reviewId: Number(review.data.id),
      };
    } catch (error) {
      const reconciledId = await this.#findReview({
        marker,
        octokit,
        owner,
        pullRequestNumber: input.pullRequestNumber,
        repository,
      });
      if (reconciledId !== undefined) {
        return {
          publishedInlineFingerprints: await this.#findPublishedInlineFingerprints({
            expectedFingerprints,
            jobId: input.jobId,
            octokit,
            owner,
            pullRequestNumber: input.pullRequestNumber,
            repository,
            reviewId: reconciledId,
          }),
          reviewId: reconciledId,
        };
      }
      if (githubErrorStatus(error) === 422 && inlineComments.length > 0) {
        input.signal.throwIfAborted();
        const reviewId = await this.#publishSummaryFallback({
          body: bodyWithMarker(renderReview(input.result), marker),
          expectedHeadSha: input.expectedHeadSha,
          marker,
          octokit,
          owner,
          pullRequestNumber: input.pullRequestNumber,
          repository,
          signal: input.signal,
        });
        return { publishedInlineFingerprints: [], reviewId };
      }
      throw error;
    }
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

  async #findPublishedInlineFingerprints(input: {
    expectedFingerprints: ReadonlySet<string>;
    jobId: number;
    octokit: Awaited<ReturnType<App['getInstallationOctokit']>>;
    owner: string;
    pullRequestNumber: number;
    repository: string;
    reviewId: number;
  }): Promise<string[]> {
    const inspect = async (attempt: number): Promise<string[]> => {
      const fingerprints = new Set<string>();
      for (let page = 1; ; page += 1) {
        const response = await this.#withRetry(() =>
          input.octokit.request(
            'GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments',
            {
              owner: input.owner,
              page,
              per_page: 100,
              pull_number: input.pullRequestNumber,
              repo: input.repository,
              review_id: input.reviewId,
            },
          ),
        );
        for (const comment of response.data) {
          const marker = parseFindingPublicationMarker(comment.body);
          if (marker?.jobId === input.jobId && input.expectedFingerprints.has(marker.fingerprint)) {
            fingerprints.add(marker.fingerprint);
          }
        }
        if (response.data.length < 100) {
          break;
        }
      }
      if (fingerprints.size === input.expectedFingerprints.size || attempt === 2) {
        return [...fingerprints];
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250 * 2 ** attempt);
      });
      return inspect(attempt + 1);
    };

    return inspect(0);
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
    return withGitHubRetry(operation);
  }
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

export function canManageRepositoryRole(role: string): boolean {
  return ['admin', 'maintain', 'triage', 'write'].includes(role);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function githubErrorStatus(error: unknown): number | undefined {
  const record = asRecord(error);
  return typeof record?.status === 'number' ? record.status : undefined;
}

function bodyWithMarker(body: string, marker: string): string {
  const suffix = `\n\n${marker}`;
  return `${limitGitHubBody(body, maximumGitHubBodyCharacters - suffix.length)}${suffix}`;
}

function renderMarkedInlineBody(comment: ReviewInlineComment, jobId: number): string {
  const marker = findingPublicationMarker(jobId, comment.fingerprint);
  if (!comment.body.endsWith(marker)) {
    throw new Error(`inline finding ${comment.fingerprint} is missing its trusted marker`);
  }
  return bodyWithMarker(comment.body.slice(0, -marker.length).trimEnd(), marker);
}

function splitRepository(value: string): [string, string] {
  const [owner, repository, ...rest] = value.split('/');
  if (owner === undefined || repository === undefined || rest.length > 0) {
    throw new Error(`invalid repository: ${value}`);
  }
  return [owner, repository];
}
