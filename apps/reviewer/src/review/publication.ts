import type { ReviewableLines } from './diff-lines.js';
import { type ReviewResult, findingFingerprint, findingSeverityMarkers } from './result.js';

export interface ReviewInlineComment {
  body: string;
  fingerprint: string;
  line: number;
  path: string;
}

export interface PreparedReviewPublication {
  inlineComments: ReviewInlineComment[];
  inlineFindingIndexes: ReadonlySet<number>;
}

export function prepareReviewPublication(
  result: ReviewResult,
  reviewableLines: ReviewableLines,
  jobId: number,
): PreparedReviewPublication {
  const inlineComments: ReviewInlineComment[] = [];
  const inlineFindingIndexes = new Set<number>();

  for (const [index, finding] of result.findings.entries()) {
    const path = finding.file.replace(/^\.\//, '');
    if (!reviewableLines.get(path)?.has(finding.line)) {
      continue;
    }
    const fingerprint = findingFingerprint(finding);
    inlineFindingIndexes.add(index);
    inlineComments.push({
      body: renderInlineFinding(finding, findingPublicationMarker(jobId, fingerprint)),
      fingerprint,
      line: finding.line,
      path,
    });
  }

  return { inlineComments, inlineFindingIndexes };
}

export function findingPublicationMarker(jobId: number, fingerprint: string): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error('invalid finding publication marker identity');
  }
  return `<!-- leverframe:finding:${fingerprint}:job:${jobId} -->`;
}

export function parseFindingPublicationMarker(
  body: string,
): { fingerprint: string; jobId: number } | undefined {
  const matches = [
    ...body.matchAll(/<!-- leverframe:finding:([0-9a-f]{16}):job:([1-9][0-9]*) -->/g),
  ];
  if (matches.length !== 1) {
    return undefined;
  }
  const jobId = Number(matches[0]?.[2]);
  const fingerprint = matches[0]?.[1];
  return Number.isSafeInteger(jobId) && fingerprint !== undefined
    ? { fingerprint, jobId }
    : undefined;
}

export function findingResolutionMarker(jobId: number, fingerprint: string): string {
  if (!Number.isSafeInteger(jobId) || jobId <= 0 || !/^[0-9a-f]{16}$/.test(fingerprint)) {
    throw new Error('invalid finding resolution marker identity');
  }
  return `<!-- leverframe:resolution:${fingerprint}:job:${jobId} -->`;
}

function renderInlineFinding(finding: ReviewResult['findings'][number], marker: string): string {
  return [
    `${findingSeverityMarkers[finding.severity]} **[${finding.severity.toUpperCase()}] ${finding.title}**`,
    '',
    finding.explanation,
    '',
    `**Evidence:** ${finding.evidence}`,
    '',
    `**Suggested action:** ${finding.suggested_action}`,
    '',
    `_Confidence: ${finding.confidence}_`,
    '',
    marker,
  ].join('\n');
}
