import { productName, reviewProtocol } from '../identity.js';
import { type ReviewResult, reviewCoverage } from './result.js';

interface ReviewStatusJob {
  headSha: string;
  pullRequestNumber: number;
  repository: string;
}

export function failurePhase(state: string): string {
  return state.toLowerCase().replaceAll('_', ' ');
}

export function sanitizeCheckError(message: string): string {
  const firstLine = message.split('\n', 1)[0] ?? 'Unknown error';
  return firstLine.slice(0, 500);
}

export function renderProgressComment(job: ReviewStatusJob, checkRunId: number): string {
  return [
    reviewProtocol.statusMarker,
    `## ${productName} review`,
    '',
    `⏳ Reviewing \`${job.headSha.slice(0, 7)}\``,
    '',
    'Preparing an isolated environment and running Codex.',
    '',
    `[View check run](https://github.com/${job.repository}/runs/${checkRunId})`,
  ].join('\n');
}

export function renderCompletedComment(input: {
  checkRunId: number;
  durationMilliseconds: number;
  job: ReviewStatusJob;
  result: ReviewResult;
  reviewBaseSha: string;
  reviewId: number | undefined;
  reviewMode: 'full' | 'incremental';
  pendingThreadResolutionCount?: number;
  resolvedThreadCount?: number;
}): string {
  const findingCount = input.result.findings.length;
  const fixedCount =
    input.result.finding_updates?.filter((update) => update.status === 'fixed').length ?? 0;
  const stillPresentCount =
    input.result.finding_updates?.filter((update) => update.status === 'still_present').length ?? 0;
  const findingLabel = findingCount === 1 ? 'finding' : 'findings';
  const testCounts = new Map<string, number>();
  for (const test of input.result.tests_run) {
    testCounts.set(test.status, (testCounts.get(test.status) ?? 0) + 1);
  }
  const verification = ['passed', 'failed', 'not_run']
    .flatMap((status) => {
      const count = testCounts.get(status) ?? 0;
      return count === 0 ? [] : [`${count} ${status.replace('_', ' ')}`];
    })
    .join(', ');
  const verificationDescription =
    input.reviewMode === 'incremental' && findingCount === 0 && (testCounts.get('failed') ?? 0) > 0
      ? `${verification}; no new defect was attributed to this push`
      : verification || 'no tests run';
  const seconds = Math.max(1, Math.round(input.durationMilliseconds / 1_000));
  const coverage = reviewCoverage(input.result);
  const icon =
    coverage?.complete !== true ? '⚪' : findingCount > 0 || stillPresentCount > 0 ? '🟡' : '🟢';
  const findingDescription =
    input.reviewMode === 'incremental'
      ? `${findingCount} new ${findingLabel}`
      : `${findingCount} ${findingLabel}`;
  const reviewLink =
    input.reviewId === undefined
      ? ''
      : `[Open review](https://github.com/${input.job.repository}/pull/${input.job.pullRequestNumber}#pullrequestreview-${input.reviewId}) · `;
  const reviewBaseShort = input.reviewBaseSha.slice(0, 7);
  const headShort = input.job.headSha.slice(0, 7);
  const lifecycle = [
    ...(stillPresentCount === 0
      ? []
      : [
          `- ${stillPresentCount} existing ${stillPresentCount === 1 ? 'finding remains' : 'findings remain'} unresolved`,
        ]),
    ...(fixedCount === 0
      ? []
      : [
          `- ${fixedCount} existing ${fixedCount === 1 ? 'finding was' : 'findings were'} verified fixed`,
        ]),
    ...((input.resolvedThreadCount ?? 0) === 0
      ? []
      : [
          `- ${input.resolvedThreadCount} fixed review ${input.resolvedThreadCount === 1 ? 'thread was' : 'threads were'} resolved`,
        ]),
    ...((input.pendingThreadResolutionCount ?? 0) === 0
      ? []
      : [
          `- ${input.pendingThreadResolutionCount} fixed review ${input.pendingThreadResolutionCount === 1 ? 'thread is' : 'threads are'} pending resolution or require operator attention`,
        ]),
  ];
  const coverageLine =
    coverage === undefined
      ? []
      : [
          `- ${coverage.reviewed} of ${coverage.changed} changed files reviewed${
            coverage.omitted === 0 ? '' : ` · ${coverage.omitted} omitted`
          }`,
        ];

  return [
    reviewProtocol.statusMarker,
    `## ${productName} review`,
    '',
    `${icon} ${input.reviewMode === 'incremental' ? 'Incremental review' : 'Review'} completed in ${seconds}s`,
    '',
    `- ${findingDescription}`,
    ...lifecycle,
    ...coverageLine,
    `- Verification: ${verificationDescription}`,
    '',
    `[Changes \`${reviewBaseShort}..${headShort}\`](https://github.com/${input.job.repository}/compare/${input.reviewBaseSha}...${input.job.headSha}) · [Commit \`${headShort}\`](https://github.com/${input.job.repository}/commit/${input.job.headSha}) · ${reviewLink}[View check run](https://github.com/${input.job.repository}/runs/${input.checkRunId})`,
  ].join('\n');
}

export function renderSupersededComment(job: ReviewStatusJob, checkRunId: number): string {
  return [
    reviewProtocol.statusMarker,
    `## ${productName} review`,
    '',
    '⚪ Review superseded by a newer commit',
    '',
    `- Superseded commit: \`${job.headSha.slice(0, 7)}\``,
    '- The stale review was not published.',
    '',
    `[View check run](https://github.com/${job.repository}/runs/${checkRunId})`,
  ].join('\n');
}

export function renderCancelledComment(
  job: ReviewStatusJob,
  checkRunId: number,
  reason: string,
): string {
  return [
    reviewProtocol.statusMarker,
    `## ${productName} review`,
    '',
    '⚪ Review cancelled',
    '',
    `- Commit: \`${job.headSha.slice(0, 7)}\``,
    `- Reason: ${reason}`,
    '- No review was published.',
    '',
    `[View check run](https://github.com/${job.repository}/runs/${checkRunId})`,
  ].join('\n');
}

export function renderFailedComment(input: {
  checkRunId: number;
  error: string;
  job: ReviewStatusJob;
  phase: string;
}): string {
  return [
    reviewProtocol.statusMarker,
    `## ${productName} review`,
    '',
    '🔴 Review could not complete',
    '',
    `- Phase: ${failurePhase(input.phase)}`,
    `- Reviewed commit: \`${input.job.headSha.slice(0, 7)}\``,
    `- Error: ${sanitizeCheckError(input.error)}`,
    '',
    `[View check run](https://github.com/${input.job.repository}/runs/${input.checkRunId})`,
  ].join('\n');
}
