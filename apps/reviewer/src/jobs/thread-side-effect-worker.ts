import type { CredentialStore } from '../github/credentials.js';
import { githubRetryDelayMilliseconds } from '../github/retry.js';
import {
  GitHubReviewThreadClient,
  GitHubThreadResolutionError,
} from '../github/review-thread-client.js';
import { sanitizeCheckError } from '../review/status-comment.js';
import type { JobDatabase } from './database.js';

const recoveryDelayMilliseconds = 60 * 60_000;
const maximumImmediateAttempts = 4;

export class ThreadSideEffectWorker {
  #loopPromise: Promise<void> | undefined;
  #running = false;
  #stopPromise: Promise<void> | undefined;

  constructor(
    readonly options: {
      credentials: CredentialStore;
      database: JobDatabase;
    },
  ) {}

  get isRunning(): boolean {
    return this.#running;
  }

  start(): void {
    if (this.#running || this.#stopPromise !== undefined) {
      return;
    }
    this.#running = true;
    this.#loopPromise = this.#loop()
      .catch((error: unknown) => console.error('GitHub thread worker stopped', error))
      .finally(() => {
        this.#running = false;
        this.#loopPromise = undefined;
      });
  }

  async stop(): Promise<void> {
    if (this.#stopPromise !== undefined) {
      return this.#stopPromise;
    }
    this.#running = false;
    this.#stopPromise = this.#loopPromise ?? Promise.resolve();
    return this.#stopPromise;
  }

  async runOnce(): Promise<boolean> {
    if (await this.#processAssociation()) {
      return true;
    }
    return this.#processResolution();
  }

  async #loop(): Promise<void> {
    while (this.#running) {
      if (!(await this.runOnce())) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_000);
        });
      }
    }
  }

  async #processAssociation(): Promise<boolean> {
    const pending = this.options.database.nextPendingGitHubThreadAssociation();
    if (pending === undefined) {
      return false;
    }
    if (!this.options.credentials.exists()) {
      this.options.database.retryGitHubThreadAssociation({
        delayMilliseconds: 60_000,
        error: 'GitHub App credentials are not configured',
        jobId: pending.jobId,
      });
      return true;
    }
    try {
      const client = new GitHubReviewThreadClient(this.options.credentials.read());
      const associations = await client.findPublishedFindingThreads(pending);
      for (const association of associations) {
        this.options.database.recordGitHubThreadAssociation({
          ...association,
          jobId: pending.jobId,
          pullRequestNumber: pending.pullRequestNumber,
          repository: pending.repository,
          reviewDatabaseId: String(pending.reviewDatabaseId),
        });
      }
      const remaining = this.options.database.remainingGitHubThreadAssociationFingerprints(
        pending.jobId,
      );
      if (remaining.length === 0) {
        this.options.database.completeGitHubThreadAssociation(pending.jobId);
      } else {
        this.#deferAssociation(
          pending.jobId,
          pending.attempt,
          `GitHub has not exposed ${remaining.length} expected review thread${remaining.length === 1 ? '' : 's'} yet`,
        );
      }
    } catch (error) {
      this.#deferAssociation(pending.jobId, pending.attempt, errorMessage(error));
    }
    return true;
  }

  #deferAssociation(jobId: number, attempt: number, error: string): void {
    if (attempt < maximumImmediateAttempts) {
      this.options.database.retryGitHubThreadAssociation({
        delayMilliseconds: Math.min(recoveryDelayMilliseconds, 5_000 * 2 ** attempt),
        error,
        jobId,
      });
    } else {
      this.options.database.failGitHubThreadAssociation({
        error,
        jobId,
        retryDelayMilliseconds: recoveryDelayMilliseconds,
      });
    }
    console.error(`failed to associate GitHub review threads for job ${jobId}: ${error}`);
  }

  async #processResolution(): Promise<boolean> {
    const pending = this.options.database.nextPendingThreadResolution();
    if (pending === undefined) {
      return false;
    }
    if (!this.options.credentials.exists()) {
      this.options.database.retryThreadResolution({
        delayMilliseconds: 60_000,
        error: 'GitHub App credentials are not configured',
        id: pending.id,
      });
      return true;
    }
    try {
      const result = await new GitHubReviewThreadClient(
        this.options.credentials.read(),
      ).resolveFindingThread({
        evidence: pending.evidence,
        expectedHeadSha: pending.headSha,
        fingerprint: pending.fingerprint,
        installationId: pending.installationId,
        jobId: pending.jobId,
        pullRequestNumber: pending.pullRequestNumber,
        repository: pending.repository,
        threadNodeId: pending.threadNodeId,
      });
      this.options.database.markThreadResolved({
        id: pending.id,
        ...(result.resolutionCommentNodeId === undefined
          ? {}
          : { resolutionCommentNodeId: result.resolutionCommentNodeId }),
      });
    } catch (error) {
      const message = errorMessage(error);
      const retryable =
        error instanceof GitHubThreadResolutionError
          ? error.retryable
          : githubRetryDelayMilliseconds(error, pending.attempt) !== undefined;
      if (retryable && pending.attempt < maximumImmediateAttempts) {
        this.options.database.retryThreadResolution({
          delayMilliseconds: Math.min(recoveryDelayMilliseconds, 5_000 * 2 ** pending.attempt),
          error: message,
          id: pending.id,
        });
      } else {
        this.options.database.failThreadResolution({
          error: message,
          id: pending.id,
          retryDelayMilliseconds: recoveryDelayMilliseconds,
        });
      }
      console.error(`failed to resolve GitHub review thread ${pending.threadNodeId}: ${message}`);
    }
    return true;
  }
}

function errorMessage(error: unknown): string {
  return sanitizeCheckError(error instanceof Error ? error.message : String(error));
}
