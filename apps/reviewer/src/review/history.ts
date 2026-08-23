import { readFileSync } from 'node:fs';
import { runProcess } from '../system/process.js';
import { type ReviewResult, findingFingerprint, reviewResultSchema } from './result.js';

export function loadPreviousResults(paths: string[] | undefined): ReviewResult | undefined {
  if (paths === undefined || paths.length === 0) {
    return undefined;
  }

  const findings = new Map<string, ReviewResult['findings'][number]>();
  let newestArtifactLoaded = false;
  for (const [index, path] of paths.entries()) {
    try {
      const result = reviewResultSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
      if (index === 0) {
        newestArtifactLoaded = true;
      }
      for (const finding of result.findings) {
        const key = findingFingerprint(finding);
        if (!findings.has(key)) {
          findings.set(key, finding);
        }
      }
    } catch (error) {
      console.warn(`could not load previous review result ${path}:`, error);
    }
  }

  if (!newestArtifactLoaded) {
    return undefined;
  }
  return {
    findings: [...findings.values()],
    limitations: [],
    summary: 'Previously reported findings',
    tests_run: [],
  };
}

export function mergePreviousResults(
  results: readonly ReviewResult[] | undefined,
): ReviewResult | undefined {
  if (results === undefined || results.length === 0) {
    return undefined;
  }
  const findings = new Map<string, ReviewResult['findings'][number]>();
  for (const result of results) {
    for (const finding of result.findings) {
      const key = findingFingerprint(finding);
      if (!findings.has(key)) {
        findings.set(key, finding);
      }
    }
  }
  return {
    findings: [...findings.values()],
    limitations: [],
    summary: 'Previously reported findings',
    tests_run: [],
  };
}

export interface ReviewContext {
  previousResult: ReviewResult | undefined;
  reviewBaseSha: string;
  reviewMode: 'full' | 'incremental';
}

/**
 * A completed row is not enough to establish incremental-review history: the
 * result artifact must parse successfully before its head can be used as the
 * incremental boundary.
 */
export function selectReviewContext(input: {
  baseSha: string;
  forceFull?: boolean;
  previousReview?: { headSha: string; resultPaths: string[]; results?: ReviewResult[] };
}): ReviewContext {
  if (input.forceFull === true || input.previousReview === undefined) {
    return {
      previousResult: undefined,
      reviewBaseSha: input.baseSha,
      reviewMode: 'full',
    };
  }

  const previousResult =
    mergePreviousResults(input.previousReview.results) ??
    loadPreviousResults(input.previousReview.resultPaths);
  if (previousResult === undefined) {
    console.warn(
      `previous review artifacts for ${input.previousReview.headSha} could not be loaded; using full review at ${input.baseSha}`,
    );
    return {
      previousResult: undefined,
      reviewBaseSha: input.baseSha,
      reviewMode: 'full',
    };
  }

  return {
    previousResult,
    reviewBaseSha: input.previousReview.headSha,
    reviewMode: 'incremental',
  };
}

export async function isAncestor(
  workspace: string,
  ancestor: string,
  descendant: string,
  signal: AbortSignal,
): Promise<boolean> {
  return runProcess('git', ['merge-base', '--is-ancestor', ancestor, descendant], {
    cwd: workspace,
    signal,
  })
    .then(() => true)
    .catch(() => false);
}
