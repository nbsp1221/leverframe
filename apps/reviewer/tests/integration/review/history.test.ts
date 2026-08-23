import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReviewResult } from '../../../src/review/result.js';
import {
  loadPreviousResults,
  mergePreviousResults,
  selectReviewContext,
} from '../../../src/review/history.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

function resultAt(file: string, line: number, title = 'Incorrect behavior'): ReviewResult {
  return {
    findings: [
      {
        confidence: 'high',
        evidence: 'observable behavior',
        explanation: 'the behavior is incorrect',
        file,
        line,
        severity: 'high',
        suggested_action: 'correct the behavior',
        title,
      },
    ],
    limitations: [],
    summary: 'Review result',
    tests_run: [],
  };
}

describe('previous review history', () => {
  it('merges recent findings and keeps the newest result for each fingerprint', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-history-test-'));
    temporaryDirectories.push(directory);
    const newestPath = join(directory, 'newest.json');
    const olderPath = join(directory, 'older.json');
    writeFileSync(newestPath, JSON.stringify(resultAt('src/access.ts', 4)));
    writeFileSync(olderPath, JSON.stringify(resultAt('src/access.ts', 4)));

    const result = loadPreviousResults([newestPath, olderPath]);

    expect(result?.findings).toEqual(resultAt('src/access.ts', 4).findings);
  });

  it('keeps distinct findings that share a file and line', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-history-test-'));
    temporaryDirectories.push(directory);
    const newestPath = join(directory, 'newest.json');
    const olderPath = join(directory, 'older.json');
    const newest = resultAt('src/access.ts', 4, 'New defect');
    const older = resultAt('src/access.ts', 4, 'Earlier defect');
    writeFileSync(newestPath, JSON.stringify(newest));
    writeFileSync(olderPath, JSON.stringify(older));

    const result = loadPreviousResults([newestPath, olderPath]);

    expect(result?.findings).toEqual([...newest.findings, ...older.findings]);
    expect(mergePreviousResults([newest, older])?.findings).toEqual([
      ...newest.findings,
      ...older.findings,
    ]);
  });

  it('returns no context when there is no usable review history', () => {
    expect(loadPreviousResults(undefined)).toBeUndefined();
    expect(loadPreviousResults([])).toBeUndefined();
  });

  it('uses a full review from the PR base when a completed artifact is unreadable', () => {
    const result = selectReviewContext({
      baseSha: 'b'.repeat(40),
      previousReview: {
        headSha: 'a'.repeat(40),
        resultPaths: ['/missing/review-result.json'],
      },
    });

    expect(result).toEqual({
      previousResult: undefined,
      reviewBaseSha: 'b'.repeat(40),
      reviewMode: 'full',
    });
  });

  it('does not use an older artifact for a newer incremental boundary', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-history-test-'));
    temporaryDirectories.push(directory);
    const olderPath = join(directory, 'older.json');
    writeFileSync(olderPath, JSON.stringify(resultAt('src/access.ts', 4)));

    const result = selectReviewContext({
      baseSha: 'b'.repeat(40),
      previousReview: {
        headSha: 'a'.repeat(40),
        resultPaths: [join(directory, 'missing-newest.json'), olderPath],
      },
    });

    expect(result).toEqual({
      previousResult: undefined,
      reviewBaseSha: 'b'.repeat(40),
      reviewMode: 'full',
    });
  });

  it('keeps incremental mode when a prior artifact is valid but has no findings', () => {
    const directory = mkdtempSync(join(tmpdir(), 'review-history-test-'));
    temporaryDirectories.push(directory);
    const resultPath = join(directory, 'empty.json');
    writeFileSync(
      resultPath,
      JSON.stringify({ findings: [], limitations: [], summary: 'No defects', tests_run: [] }),
    );

    const result = selectReviewContext({
      baseSha: 'b'.repeat(40),
      previousReview: { headSha: 'a'.repeat(40), resultPaths: [resultPath] },
    });

    expect(result.reviewMode).toBe('incremental');
    expect(result.reviewBaseSha).toBe('a'.repeat(40));
    expect(result.previousResult?.findings).toEqual([]);
  });
});
