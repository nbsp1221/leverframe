import type { CredentialStore } from '../github/credentials.js';
import { GitHubAppClient } from '../github/client.js';
import type { ManualCommand } from './command.js';
import type { JobDatabase } from './database.js';
import type { ReviewWorker } from './worker.js';

export class ManualCommandHandler {
  constructor(
    readonly options: {
      credentials: CredentialStore;
      database: JobDatabase;
      worker: ReviewWorker;
    },
  ) {}

  async handle(command: ManualCommand): Promise<{ status: string }> {
    if (!this.options.database.acceptManualCommand(command)) {
      return { status: 'duplicate' };
    }
    const github = new GitHubAppClient(this.options.credentials.read());
    try {
      if (!(await github.actorCanManagePullRequest(command))) {
        await this.#reply(
          github,
          command,
          `@${command.actor}, triage or write access is required.`,
        );
        this.options.database.completeManualCommand(command.deliveryId, 'REJECTED', 'unauthorized');
        return { status: 'rejected' };
      }

      if (command.command === 'status') {
        const latest = this.options.database.getLatestJobStatus(
          command.repository,
          command.pullRequestNumber,
        );
        await this.#reply(
          github,
          command,
          latest === undefined
            ? 'No review job has been recorded for this pull request.'
            : `Latest review job \`${latest.id}\` is **${latest.state.toLowerCase()}** at \`${latest.headSha.slice(0, 7)}\`.`,
        );
        this.options.database.completeManualCommand(command.deliveryId, 'COMPLETED');
        return { status: 'completed' };
      }

      if (command.command === 'cancel') {
        const cancelled = this.options.database.cancelActiveJobs(
          command.repository,
          command.pullRequestNumber,
          `Review cancelled by @${command.actor}.`,
        );
        this.options.worker.cancelManual(command);
        await this.#reply(github, command, `Cancelled ${cancelled} active review job(s).`);
        this.options.database.completeManualCommand(command.deliveryId, 'COMPLETED');
        return { status: 'completed' };
      }

      const pullRequest = await github.getPullRequest(command);
      if (pullRequest.state !== 'open' || pullRequest.draft) {
        await this.#reply(
          github,
          command,
          'Reviews can only run on an open, non-draft pull request.',
        );
        this.options.database.completeManualCommand(command.deliveryId, 'REJECTED', 'inactive PR');
        return { status: 'rejected' };
      }
      const action =
        command.command === 'review_full' ? 'manual_full' : `manual_${command.command}`;
      const job = {
        action,
        deliveryId: command.deliveryId,
        headSha: pullRequest.headSha,
        installationId: command.installationId,
        policyVersion: `v3:${command.command}:${command.deliveryId}`,
        pullRequestNumber: command.pullRequestNumber,
        pullRequestTitle: pullRequest.title,
        repository: command.repository,
      };
      const result = this.options.database.enqueuePullRequest(job);
      if (result.jobCreated) {
        this.options.worker.cancelSuperseded(job);
      }
      await this.#reply(
        github,
        command,
        result.jobCreated ? 'Review queued.' : 'Review already queued.',
      );
      this.options.database.completeManualCommand(command.deliveryId, 'COMPLETED');
      return { status: result.jobCreated ? 'queued' : 'duplicate' };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.options.database.completeManualCommand(
        command.deliveryId,
        'FAILED',
        detail.slice(0, 1_000),
      );
      throw error;
    }
  }

  async #reply(github: GitHubAppClient, command: ManualCommand, body: string): Promise<void> {
    await github.createCommandReply({
      body,
      deliveryId: command.deliveryId,
      installationId: command.installationId,
      pullRequestNumber: command.pullRequestNumber,
      repository: command.repository,
    });
  }
}
