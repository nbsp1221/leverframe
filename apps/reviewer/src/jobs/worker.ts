import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { CredentialStore } from '../github/credentials.js';
import type { ReviewableLines } from '../review/diff-lines.js';
import type { SandboxReviewer } from '../sandbox/reviewer.js';
import { GitHubAppClient } from '../github/client.js';
import { reviewProtocol } from '../identity.js';
import { selectReviewContext } from '../review/history.js';
import { prepareReviewPublication } from '../review/publication.js';
import { parseRepositoryPolicy } from '../review/repository-policy.js';
import { type ReviewResult, reviewConclusion } from '../review/result.js';
import {
  failurePhase,
  renderCancelledComment,
  renderCompletedComment,
  renderFailedComment,
  renderProgressComment,
  renderSupersededComment,
  sanitizeCheckError,
} from '../review/status-comment.js';
import type { ManualCommand } from './command.js';
import type {
  JobDatabase,
  PullRequestCancellationInput,
  PullRequestJobInput,
  ReviewJob,
} from './database.js';

interface ActiveCancellation {
  reason: string;
  state: 'CANCELLED' | 'SUPERSEDED';
}

interface ActiveReview {
  cancellation?: ActiveCancellation;
  controller: AbortController;
  headSha: string;
  shutdown: boolean;
}

export class ReviewWorker {
  readonly #activeReviews = new Map<string, ActiveReview>();
  #running = false;
  #shutdownRequested = false;
  #loopPromise: Promise<void> | undefined;
  #stopPromise: Promise<void> | undefined;

  constructor(
    readonly options: {
      allowedOwnerId: number;
      credentials: CredentialStore;
      database: JobDatabase;
      jobsDirectory: string;
      reviewer: SandboxReviewer;
    },
  ) {}

  start(): void {
    if (this.#running || this.#shutdownRequested) {
      return;
    }
    this.#running = true;
    this.#loopPromise = this.#loop()
      .catch((error: unknown) => {
        console.error('review worker stopped', error);
      })
      .finally(() => {
        this.#running = false;
        this.#loopPromise = undefined;
      });
  }

  get isRunning(): boolean {
    return this.#running && !this.#shutdownRequested;
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }

    this.#running = false;
    this.#shutdownRequested = true;
    for (const active of this.#activeReviews.values()) {
      active.shutdown = true;
      active.controller.abort();
    }

    // Invalidate in-flight updates before waiting for asynchronous cleanup.
    this.options.database.requeueActiveJobs();

    const loopPromise = this.#loopPromise;
    this.#stopPromise = (async () => {
      await loopPromise;
      while (this.#activeReviews.size > 0) {
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      }
    })();
    return this.#stopPromise;
  }

  cancelSuperseded(input: PullRequestJobInput): void {
    const active = this.#activeReviews.get(pullRequestKey(input));
    if (
      active !== undefined &&
      active.headSha !== input.headSha &&
      !active.controller.signal.aborted
    ) {
      console.log(`cancelling active review at ${active.headSha} for newer head ${input.headSha}`);
      active.cancellation = {
        reason: 'A newer pull request commit replaced this review run.',
        state: 'SUPERSEDED',
      };
      active.controller.abort();
    }
  }

  cancelPullRequest(input: PullRequestCancellationInput): void {
    const active = this.#activeReviews.get(pullRequestKey(input));
    if (active === undefined || active.controller.signal.aborted) {
      return;
    }

    const reason =
      input.action === 'closed'
        ? 'The pull request was closed.'
        : 'The pull request was converted to draft.';
    console.log(`cancelling active review at ${active.headSha}: ${reason}`);
    active.cancellation = { reason, state: 'CANCELLED' };
    active.controller.abort();
  }

  cancelManual(command: ManualCommand): void {
    const active = this.#activeReviews.get(pullRequestKey(command));
    if (active === undefined || active.controller.signal.aborted) {
      return;
    }
    active.cancellation = {
      reason: `Review cancelled by @${command.actor}.`,
      state: 'CANCELLED',
    };
    active.controller.abort();
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      const job = this.options.database.claimNextJob();
      if (job === undefined) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
        continue;
      }

      try {
        await this.#process(job);
      } catch (error) {
        // Cancellation/status finalization is best effort. A failure there
        // must not terminate supervision for later jobs.
        const message = error instanceof Error ? error.message : String(error);
        console.error(`review job ${job.id} supervision failure: ${message}`);
        const terminalized = this.options.database.updateJob({
          attempt: job.attempt ?? 0,
          errorCode: isTimeoutError(error) ? 'TIMEOUT' : 'SUPERVISION_FAILED',
          error: message.slice(0, 4_000),
          expectedStates: [
            'CHECKING_OUT',
            'SANDBOX_CREATING',
            'REVIEWING',
            'VALIDATING',
            'PUBLISHING',
          ],
          id: job.id,
          state: isTimeoutError(error) ? 'TIMED_OUT' : 'FAILED',
        });
        if (terminalized) {
          this.#removeEvents(job);
        }
      }
    }
  }

  async #process(job: ReviewJob): Promise<void> {
    const controller = new AbortController();
    const activeKey = pullRequestKey(job);
    this.#activeReviews.set(activeKey, {
      controller,
      headSha: job.headSha,
      shutdown: false,
    });
    const startedAt = Date.now();
    console.log(`processing ${job.repository}#${job.pullRequestNumber} at ${job.headSha}`);
    let checkRunId = job.checkRunId;
    let phase = job.state;
    let github: GitHubAppClient | undefined;
    let statusCommentId: number | undefined;
    let statusCommentActivated = false;
    try {
      if (!this.options.credentials.exists()) {
        throw new Error('GitHub App credentials are not configured');
      }

      github = new GitHubAppClient(this.options.credentials.read());
      if (checkRunId === undefined) {
        checkRunId = await github.createQueuedCheckRun({
          headSha: job.headSha,
          installationId: job.installationId,
          jobId: job.id,
          pullRequestNumber: job.pullRequestNumber,
          repository: job.repository,
        });
        this.options.database.updateJob({
          checkRunId,
          attempt: job.attempt ?? 0,
          expectedStates: ['CHECKING_OUT'],
          id: job.id,
          state: 'CHECKING_OUT',
        });
      }
      phase = 'CHECKING_OUT';
      await github.startCheckRun({
        checkRunId,
        installationId: job.installationId,
        repository: job.repository,
      });
      const pullRequest = await github.getPullRequest({
        installationId: job.installationId,
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
      });
      if (pullRequest.headSha !== job.headSha) {
        phase = 'SUPERSEDED';
        this.options.database.updateJob({
          attempt: job.attempt ?? 0,
          expectedStates: [
            'CHECKING_OUT',
            'SANDBOX_CREATING',
            'REVIEWING',
            'VALIDATING',
            'PUBLISHING',
          ],
          id: job.id,
          state: 'SUPERSEDED',
        });
        await github.completeCheckRun({
          checkRunId,
          conclusion: 'cancelled',
          installationId: job.installationId,
          output: {
            summary: 'A newer pull request commit replaced this review run.',
            title: 'Code review superseded',
          },
          repository: job.repository,
        });
        return;
      }

      const pullRequestState = this.options.database.activatePullRequestJob(job);
      statusCommentActivated = true;
      statusCommentId = await this.#writeStatusComment({
        body: renderProgressComment(job, checkRunId),
        github,
        job,
        statusCommentId: pullRequestState.statusCommentId,
      });

      const jobDirectory = join(this.options.jobsDirectory, String(job.id));
      const previousReview = this.options.database.findPreviousCompletedReview(job);
      let { previousResult, reviewBaseSha, reviewMode } = selectReviewContext({
        baseSha: pullRequest.baseSha,
        forceFull: job.action === 'manual_full',
        ...(previousReview === undefined ? {} : { previousReview }),
      });
      mkdirSync(jobDirectory, { recursive: true, mode: 0o700 });
      const policyInstructions = await this.#loadPolicyInstructions({
        defaultBranch: pullRequest.defaultBranch,
        github,
        job,
      });
      const installationToken = await github.createRepositoryReadToken({
        allowedOwnerId: this.options.allowedOwnerId,
        installationId: job.installationId,
        repositoryId: pullRequest.repositoryId,
      });

      const transitionedToSandbox = this.options.database.updateJob({
        attempt: job.attempt ?? 0,
        expectedStates: ['CHECKING_OUT'],
        id: job.id,
        state: 'SANDBOX_CREATING',
      });
      if (!transitionedToSandbox) {
        throw new Error('review job could not enter SANDBOX_CREATING');
      }
      phase = 'SANDBOX_CREATING';
      const transitionedToReview = this.options.database.updateJob({
        attempt: job.attempt ?? 0,
        expectedStates: ['SANDBOX_CREATING'],
        id: job.id,
        state: 'REVIEWING',
      });
      if (!transitionedToReview) {
        throw new Error('review job could not enter REVIEWING');
      }
      phase = 'REVIEWING';
      const review = await this.options.reviewer.review({
        baseRef: pullRequest.baseRef,
        baseSha: pullRequest.baseSha,
        cloneUrl: pullRequest.cloneUrl,
        headSha: pullRequest.headSha,
        installationToken,
        jobDirectory,
        jobId: job.id,
        ...(policyInstructions === undefined ? {} : { policyInstructions }),
        ...(previousResult === undefined ? {} : { previousResult }),
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
        reviewBaseSha,
        reviewMode,
        signal: controller.signal,
        title: pullRequest.title,
        onPromptPrepared: (snapshot) => {
          this.options.database.recordReviewMetadata({
            baseSha: pullRequest.baseSha,
            jobId: job.id,
            model: snapshot.model,
            prompt: snapshot.prompt,
            reasoning: snapshot.reasoning,
            schema: snapshot.schema,
            pullRequestTitle: pullRequest.title,
          });
        },
      });
      if (reviewMode === 'incremental' && review.reviewMode === 'full') {
        previousResult = undefined;
        reviewBaseSha = pullRequest.baseSha;
        reviewMode = 'full';
      }
      const reviewableLines = review.reviewableLines;
      if (
        !(await this.#guardPublication({
          checkRunId,
          controller,
          github,
          job,
          statusCommentId,
        }))
      ) {
        return;
      }

      const transitionedToValidation = this.options.database.updateJob({
        attempt: job.attempt ?? 0,
        expectedStates: ['REVIEWING'],
        id: job.id,
        resultPath: review.path,
        state: 'VALIDATING',
      });
      if (!transitionedToValidation) {
        throw new Error('review job could not enter VALIDATING');
      }
      phase = 'VALIDATING';
      this.options.database.recordReviewArtifact(job.id, review.result);
      this.options.database.reconcileFindings({
        job,
        previousResult,
        result: review.result,
      });
      const transitionedToPublishing = this.options.database.updateJob({
        attempt: job.attempt ?? 0,
        expectedStates: ['VALIDATING'],
        id: job.id,
        state: 'PUBLISHING',
      });
      if (!transitionedToPublishing) {
        throw new Error('review job could not enter PUBLISHING');
      }
      phase = 'PUBLISHING';
      const { findingCount, findingLabel, stillPresentCount } = findingStatus(review.result);
      const reviewId = await this.#publishReview({
        github,
        job,
        result: review.result,
        reviewableLines,
        reviewMode,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      const detailsUrl = reviewDetailsUrl(job, reviewId, statusCommentId);
      await github.completeCheckRun({
        checkRunId,
        conclusion: reviewConclusion(review.result),
        detailsUrl,
        installationId: job.installationId,
        output: {
          summary: `${
            reviewId === undefined
              ? stillPresentCount > 0
                ? `${stillPresentCount} previously reported ${stillPresentCount === 1 ? 'finding remains' : 'findings remain'} unresolved.`
                : 'No new findings were identified in the incremental changes.'
              : `Published ${findingCount} ${findingLabel} in GitHub review ${reviewId}.`
          }`,
          title:
            findingCount === 0
              ? stillPresentCount > 0
                ? `${stillPresentCount} existing ${stillPresentCount === 1 ? 'finding is' : 'findings are'} still present`
                : reviewMode === 'incremental'
                  ? 'Incremental review completed with no new findings'
                  : 'Code review completed with no findings'
              : `${reviewMode === 'incremental' ? 'Incremental review' : 'Code review'} completed with ${findingCount} ${findingLabel}`,
        },
        repository: job.repository,
      });
      statusCommentId = await this.#writeStatusComment({
        body: renderCompletedComment({
          checkRunId,
          durationMilliseconds: Date.now() - startedAt,
          job,
          result: review.result,
          reviewBaseSha,
          reviewId,
          reviewMode,
          resolvedThreadCount: 0,
        }),
        github,
        job,
        statusCommentId,
      });
      controller.signal.throwIfAborted();
      const { completed } = this.options.database.completeReviewJob({
        attempt: job.attempt ?? 0,
        headSha: job.headSha,
        jobId: job.id,
        pullRequestNumber: job.pullRequestNumber,
        repository: job.repository,
        updates: review.result.finding_updates ?? [],
      });
      if (!completed) {
        throw new Error('review job could not enter DONE');
      }
      this.#removeEvents(job);
      logCompletion(job, reviewId);
    } catch (error) {
      await this.#handleProcessFailure({
        activeKey,
        checkRunId,
        controller,
        error,
        github,
        job,
        phase,
        statusCommentActivated,
        statusCommentId,
      });
    } finally {
      const active = this.#activeReviews.get(activeKey);
      if (active?.controller === controller) {
        this.#activeReviews.delete(activeKey);
      }
    }
  }

  async #handleProcessFailure(input: {
    activeKey: string;
    checkRunId: number | undefined;
    controller: AbortController;
    error: unknown;
    github: GitHubAppClient | undefined;
    job: ReviewJob;
    phase: string;
    statusCommentActivated: boolean;
    statusCommentId: number | undefined;
  }): Promise<void> {
    const message = input.error instanceof Error ? input.error.message : String(input.error);
    const active = this.#activeReviews.get(input.activeKey);
    if (active?.shutdown === true) {
      // stop() has already requeued the job and invalidated this attempt.
      return;
    }

    if (input.controller.signal.aborted) {
      const cancellation = active?.cancellation ?? {
        reason: 'A newer pull request commit replaced this review run.',
        state: 'SUPERSEDED' as const,
      };
      if (input.github !== undefined && input.checkRunId !== undefined) {
        await this.#finishCancellation({
          cancellation,
          checkRunId: input.checkRunId,
          github: input.github,
          job: input.job,
          statusCommentId: input.statusCommentId,
        });
      } else {
        const cancelled = this.options.database.updateJob({
          attempt: input.job.attempt ?? 0,
          expectedStates: [
            'CHECKING_OUT',
            'SANDBOX_CREATING',
            'REVIEWING',
            'VALIDATING',
            'PUBLISHING',
          ],
          id: input.job.id,
          state: cancellation.state,
        });
        if (cancelled) {
          this.#removeEvents(input.job);
        }
      }
      return;
    }

    if (
      input.github !== undefined &&
      input.checkRunId !== undefined &&
      message.startsWith('pull request head changed from ')
    ) {
      await this.#finishSuperseded({
        checkRunId: input.checkRunId,
        github: input.github,
        job: input.job,
        statusCommentId: input.statusCommentId,
      });
      return;
    }

    console.error(`review job ${input.job.id} failed: ${message}`);
    const timedOut = isTimeoutError(input.error);
    const failed = this.options.database.updateJob({
      attempt: input.job.attempt ?? 0,
      errorCode: timedOut ? 'TIMEOUT' : 'REVIEW_FAILED',
      error: message.slice(0, 4_000),
      expectedStates: [input.phase],
      id: input.job.id,
      state: timedOut ? 'TIMED_OUT' : 'FAILED',
    });
    if (failed) {
      this.#removeEvents(input.job);
    }
    if (input.github !== undefined && input.checkRunId !== undefined) {
      try {
        await input.github.completeCheckRun({
          checkRunId: input.checkRunId,
          conclusion: timedOut ? 'timed_out' : 'failure',
          installationId: input.job.installationId,
          output: {
            summary: `Review failed during ${failurePhase(input.phase)}.\n\n${sanitizeCheckError(message)}`,
            title: 'Code review failed',
          },
          repository: input.job.repository,
        });
      } catch (checkError) {
        console.error(`failed to update check run ${input.checkRunId}:`, checkError);
      }
    }
    if (
      input.github !== undefined &&
      input.checkRunId !== undefined &&
      input.statusCommentActivated
    ) {
      await this.#writeStatusComment({
        body: renderFailedComment({
          checkRunId: input.checkRunId,
          error: message,
          job: input.job,
          phase: input.phase,
        }),
        github: input.github,
        job: input.job,
        statusCommentId: input.statusCommentId,
      });
    }
  }

  async #publishReview(input: {
    github: GitHubAppClient;
    job: ReviewJob;
    result: ReviewResult;
    reviewableLines: ReviewableLines;
    reviewMode: 'full' | 'incremental';
    signal: AbortSignal;
  }): Promise<number | undefined> {
    if (input.reviewMode === 'incremental' && input.result.findings.length === 0) {
      return undefined;
    }
    const publication = prepareReviewPublication(input.result, input.reviewableLines, input.job.id);
    const published = await input.github.publishReview({
      expectedHeadSha: input.job.headSha,
      installationId: input.job.installationId,
      inlineComments: publication.inlineComments,
      inlineFindingIndexes: publication.inlineFindingIndexes,
      jobId: input.job.id,
      ...(input.job.publishedReviewId === undefined
        ? {}
        : { knownReviewId: input.job.publishedReviewId }),
      pullRequestNumber: input.job.pullRequestNumber,
      repository: input.job.repository,
      result: input.result,
      signal: input.signal,
    });
    const reviewId = published.reviewId;
    if (input.job.publishedReviewId === undefined) {
      this.options.database.updateJob({
        attempt: input.job.attempt ?? 0,
        expectedStates: ['PUBLISHING'],
        id: input.job.id,
        publishedReviewId: reviewId,
        state: 'PUBLISHING',
      });
    }
    this.options.database.queueGitHubThreadAssociation({
      expectedFingerprints: published.publishedInlineFingerprints,
      jobId: input.job.id,
      pullRequestNumber: input.job.pullRequestNumber,
      repository: input.job.repository,
      reviewDatabaseId: reviewId,
    });
    return reviewId;
  }

  async #loadPolicyInstructions(input: {
    defaultBranch: string;
    github: GitHubAppClient;
    job: ReviewJob;
  }): Promise<readonly string[] | undefined> {
    const source = await input.github.getRepositoryTextFile({
      installationId: input.job.installationId,
      path: reviewProtocol.repositoryPolicyPath,
      ref: input.defaultBranch,
      repository: input.job.repository,
    });
    return source === undefined ? undefined : parseRepositoryPolicy(source).review.instructions;
  }

  async #guardPublication(input: {
    checkRunId: number;
    controller: AbortController;
    github: GitHubAppClient;
    job: ReviewJob;
    statusCommentId: number | undefined;
  }): Promise<boolean> {
    input.controller.signal.throwIfAborted();
    const pullRequest = await input.github.getPullRequest({
      installationId: input.job.installationId,
      pullRequestNumber: input.job.pullRequestNumber,
      repository: input.job.repository,
    });
    if (pullRequest.headSha !== input.job.headSha) {
      await this.#finishSuperseded(input);
      return false;
    }

    if (pullRequest.state !== 'open' || pullRequest.draft) {
      await this.#finishCancellation({
        ...input,
        cancellation: {
          reason:
            pullRequest.state !== 'open'
              ? 'The pull request is closed.'
              : 'The pull request is a draft.',
          state: 'CANCELLED',
        },
      });
      return false;
    }

    input.controller.signal.throwIfAborted();
    return true;
  }

  async #finishSuperseded(input: {
    checkRunId: number;
    github: GitHubAppClient;
    job: ReviewJob;
    statusCommentId: number | undefined;
  }): Promise<void> {
    await this.#finishCancellation({
      ...input,
      cancellation: {
        reason: 'A newer pull request commit replaced this review run.',
        state: 'SUPERSEDED',
      },
    });
  }

  async #finishCancellation(input: {
    cancellation: ActiveCancellation;
    checkRunId: number;
    github: GitHubAppClient;
    job: ReviewJob;
    statusCommentId: number | undefined;
  }): Promise<void> {
    const attempt = input.job.attempt ?? 0;
    let cancellation = input.cancellation;
    const updated = this.options.database.updateJob({
      attempt,
      expectedStates: ['CHECKING_OUT', 'SANDBOX_CREATING', 'REVIEWING', 'VALIDATING', 'PUBLISHING'],
      id: input.job.id,
      state: cancellation.state,
    });
    if (!updated) {
      if (!this.options.database.isJobAttemptCurrent({ attempt, jobId: input.job.id })) {
        return;
      }
      const persistedState = this.options.database.getReviewJob(input.job.id)?.state;
      if (persistedState === 'CANCELLED' && cancellation.state !== persistedState) {
        cancellation = {
          reason: 'The pull request was closed or converted to draft.',
          state: persistedState,
        };
      } else if (persistedState === 'SUPERSEDED' && cancellation.state !== persistedState) {
        cancellation = {
          reason: 'A newer pull request commit replaced this review run.',
          state: persistedState,
        };
      } else if (persistedState !== cancellation.state) {
        return;
      }
    }
    if (updated) {
      this.#removeEvents(input.job);
    }
    await input.github.completeCheckRun({
      checkRunId: input.checkRunId,
      conclusion: 'cancelled',
      installationId: input.job.installationId,
      output: {
        summary: cancellation.reason,
        title:
          cancellation.state === 'SUPERSEDED' ? 'Code review superseded' : 'Code review cancelled',
      },
      repository: input.job.repository,
    });
    await this.#writeStatusComment({
      body:
        cancellation.state === 'SUPERSEDED'
          ? renderSupersededComment(input.job, input.checkRunId)
          : renderCancelledComment(input.job, input.checkRunId, cancellation.reason),
      github: input.github,
      job: input.job,
      statusCommentId: input.statusCommentId,
    });
  }

  #removeEvents(job: ReviewJob): void {
    rmSync(join(this.options.jobsDirectory, String(job.id), 'codex-events.jsonl'), { force: true });
  }

  async #writeStatusComment(input: {
    body: string;
    github: GitHubAppClient;
    job: ReviewJob;
    statusCommentId: number | undefined;
  }): Promise<number | undefined> {
    if (
      !this.options.database.isCurrentPullRequestJob({
        attempt: input.job.attempt ?? 0,
        jobId: input.job.id,
        pullRequestNumber: input.job.pullRequestNumber,
        repository: input.job.repository,
      })
    ) {
      return input.statusCommentId;
    }

    try {
      if (input.statusCommentId !== undefined) {
        await input.github.updateStatusComment({
          body: input.body,
          commentId: input.statusCommentId,
          installationId: input.job.installationId,
          repository: input.job.repository,
        });
        return input.statusCommentId;
      }

      const existingCommentId = await input.github.findStatusComment({
        installationId: input.job.installationId,
        pullRequestNumber: input.job.pullRequestNumber,
        repository: input.job.repository,
      });
      if (existingCommentId !== undefined) {
        await input.github.updateStatusComment({
          body: input.body,
          commentId: existingCommentId,
          installationId: input.job.installationId,
          repository: input.job.repository,
        });
        this.options.database.attachStatusComment({
          commentId: existingCommentId,
          attempt: input.job.attempt ?? 0,
          jobId: input.job.id,
          pullRequestNumber: input.job.pullRequestNumber,
          repository: input.job.repository,
        });
        return existingCommentId;
      }

      const commentId = await input.github.createStatusComment({
        body: input.body,
        installationId: input.job.installationId,
        pullRequestNumber: input.job.pullRequestNumber,
        repository: input.job.repository,
      });
      const attached = this.options.database.attachStatusComment({
        commentId,
        attempt: input.job.attempt ?? 0,
        jobId: input.job.id,
        pullRequestNumber: input.job.pullRequestNumber,
        repository: input.job.repository,
      });
      if (!attached) {
        console.warn(`status comment ${commentId} was created for superseded job ${input.job.id}`);
      }
      return commentId;
    } catch (error) {
      console.error(`status comment update failed for job ${input.job.id}:`, error);
      return input.statusCommentId;
    }
  }
}

function pullRequestKey(input: { pullRequestNumber: number; repository: string }): string {
  return `${input.repository}#${input.pullRequestNumber}`;
}

export function isTimeoutError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) {
    return false;
  }
  const candidate = error as { code?: unknown; timedOut?: unknown };
  return candidate.timedOut === true || candidate.code === 'ETIMEDOUT';
}

function reviewDetailsUrl(
  job: ReviewJob,
  reviewId: number | undefined,
  statusCommentId: number | undefined,
): string {
  const pullRequestUrl = `https://github.com/${job.repository}/pull/${job.pullRequestNumber}`;
  if (reviewId !== undefined) {
    return `${pullRequestUrl}#pullrequestreview-${reviewId}`;
  }
  return statusCommentId === undefined
    ? pullRequestUrl
    : `${pullRequestUrl}#issuecomment-${statusCommentId}`;
}

function findingStatus(result: ReviewResult): {
  findingCount: number;
  findingLabel: string;
  stillPresentCount: number;
} {
  const findingCount = result.findings.length;
  return {
    findingCount,
    findingLabel: findingCount === 1 ? 'finding' : 'findings',
    stillPresentCount:
      result.finding_updates?.filter((update) => update.status === 'still_present').length ?? 0,
  };
}

function logCompletion(job: ReviewJob, reviewId: number | undefined): void {
  console.log(
    reviewId === undefined
      ? `completed incremental review with no new findings for ${job.repository}#${job.pullRequestNumber}`
      : `published review ${reviewId} for ${job.repository}#${job.pullRequestNumber}`,
  );
}
