import type { PullRequestCancellationInput } from '../jobs/database.js';
import type { DevelopmentRepository } from '../storage/development-repository.js';
import type { DevelopmentResourceLifecycle } from './resource-lifecycle.js';

const postPublicationPhases = new Set([
  'IMPLEMENTING',
  'VERIFYING',
  'AWAITING_PUBLICATION_APPROVAL',
  'PUBLISHING',
  'REVIEWING',
  'AWAITING_MERGE',
  'WAITING_FOR_INPUT',
]);

export async function observeDevelopmentPullRequestClosed(options: {
  input: PullRequestCancellationInput;
  database: DevelopmentRepository;
  resources: DevelopmentResourceLifecycle;
  stopActive: (runId: number) => void;
}): Promise<void> {
  const { input } = options;
  const run = options.database.findRunByPullRequest(input);
  if (run === undefined || input.action === 'converted_to_draft') {
    return;
  }
  const pullRequest = options.database.getPullRequestReference(run.id);
  if (pullRequest?.headSha !== input.headSha || !postPublicationPhases.has(run.phase)) {
    return;
  }
  const attempt = options.database.findActiveAttempt(run.id);
  if (attempt?.leaseOwner !== undefined) {
    options.database.completeAttempt({
      id: attempt.id,
      runId: run.id,
      generation: attempt.generation,
      leaseOwner: attempt.leaseOwner,
      state: input.merged === true ? 'SUCCEEDED' : 'CANCELLED',
      outcomeCode: input.merged === true ? 'PULL_REQUEST_MERGED' : 'PULL_REQUEST_CLOSED',
    });
  }
  const current = options.database.requireRun(run.id);
  const event = {
    type: input.merged === true ? 'pull_request_merged' : 'pull_request_closed',
    source: 'GITHUB' as const,
    trust: 'SYSTEM_OBSERVED' as const,
    payload: { head_sha: input.headSha, pull_request: input.pullRequestNumber },
  };
  if (input.merged === true) {
    options.database.completeRun({
      id: current.id,
      expectedGeneration: current.generation,
      expectedLockVersion: current.lockVersion,
      event,
    });
  } else {
    options.database.cancelRun({
      id: current.id,
      expectedGeneration: current.generation,
      expectedLockVersion: current.lockVersion,
      event,
    });
  }
  options.stopActive(run.id);
  await options.resources.stopAndRetain(run.id);
}
