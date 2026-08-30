import { createHash } from 'node:crypto';

export interface DevelopmentCheckoutSnapshot {
  baseSha: string;
  cloneUrl: string;
  defaultBranch: string;
  installationId: number;
  repositoryId: number;
}

export interface DevelopmentRunCreateInput {
  repository: string;
  goal: string;
  checkout: DevelopmentCheckoutSnapshot;
  externalSource?: { provider: string; id: string; key?: string; url?: string };
  now?: string;
}

export class DevelopmentConflictError extends Error {}

export function developmentInputKey(input: DevelopmentRunCreateInput): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        externalSource: input.externalSource ?? null,
        goal: input.goal,
        repository: input.repository,
      }),
    )
    .digest('hex');
}

export function parseCheckoutSnapshot(
  normalizedJson: string,
  runId: number,
): DevelopmentCheckoutSnapshot {
  const checkout = (JSON.parse(normalizedJson) as { checkout?: unknown }).checkout;
  if (
    checkout === null ||
    typeof checkout !== 'object' ||
    !('baseSha' in checkout) ||
    typeof checkout.baseSha !== 'string' ||
    !('cloneUrl' in checkout) ||
    typeof checkout.cloneUrl !== 'string' ||
    !('defaultBranch' in checkout) ||
    typeof checkout.defaultBranch !== 'string' ||
    !('installationId' in checkout) ||
    typeof checkout.installationId !== 'number' ||
    !('repositoryId' in checkout) ||
    typeof checkout.repositoryId !== 'number'
  ) {
    throw new Error(`development run ${runId} has no accepted checkout snapshot`);
  }
  return checkout as DevelopmentCheckoutSnapshot;
}
