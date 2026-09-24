/**
 * Values shown to operators or sent as mutable product metadata. These may
 * change when the product is rebranded without changing persisted protocol
 * data.
 */
export const productName = 'Leverframe';
export const productSlug = 'leverframe';
export const productUserAgent = productSlug;
export const defaultDataDirectoryName = '.leverframe';

/**
 * Identifiers shared by GitHub output, repository configuration, and the
 * disposable sandbox.
 */
export const reviewProtocol = {
  namespace: 'leverframe',
  repositoryPolicyPath: '.github/leverframe.yml',
  sandboxNamePrefix: 'leverframe-job-',
  sandboxOutputPath: '/tmp/leverframe-review.json',
  sandboxWorkspace: '/tmp/leverframe-repository',
  statusMarker: '<!-- leverframe:review-status -->',
} as const;

export const developmentProtocol = {
  sandboxNamePrefix: 'leverframe-dev-',
  branchPrefix: 'codex/',
} as const;

export function statusCommentMarker(): string {
  return reviewProtocol.statusMarker;
}

export function commandReplyMarker(deliveryId: string): string {
  return `<!-- ${reviewProtocol.namespace}:command-reply:${deliveryId} -->`;
}

export function reviewPublicationMarker(jobId: number, headSha: string): string {
  return `<!-- ${reviewProtocol.namespace}:review-publication:${jobId}:${headSha} -->`;
}

export function reviewerSandboxName(jobId: number): string {
  return `${reviewProtocol.sandboxNamePrefix}${jobId}`;
}

export function reviewerSandboxPattern(): RegExp {
  return new RegExp(`^${reviewProtocol.sandboxNamePrefix}(\\d+)$`);
}

export function developmentSandboxName(runId: number): string {
  if (!Number.isSafeInteger(runId) || runId < 1) {
    throw new Error('development run ID must be a positive safe integer');
  }
  return `${developmentProtocol.sandboxNamePrefix}${runId}`;
}

export function developmentSandboxPattern(): RegExp {
  return new RegExp(`^${developmentProtocol.sandboxNamePrefix}(\\d+)$`);
}
