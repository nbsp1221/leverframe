import { describe, expect, it } from 'vitest';
import {
  type ReviewResult,
  findingFingerprint,
  removePreviouslyReportedFindings,
  renderReview,
  reviewConclusion,
  reviewCoverage,
  validateFindingUpdates,
} from '../../../src/review/result.js';

const previousFinding: ReviewResult['findings'][number] = {
  confidence: 'high',
  evidence: 'previous evidence',
  explanation: 'previous explanation',
  file: 'src/access.mjs',
  line: 2,
  severity: 'high',
  suggested_action: 'previous action',
  title: 'Authorization comparison is inverted',
};

const previous: ReviewResult = {
  findings: [previousFinding],
  limitations: [],
  summary: 'Previous review',
  tests_run: [],
};

describe('incremental review findings', () => {
  it('removes a reworded finding at a previously reported location', () => {
    const result = removePreviouslyReportedFindings(
      {
        ...previous,
        findings: [
          {
            ...previousFinding,
            title: 'Non-owners can read profiles',
          },
        ],
        summary: 'Repeated finding',
      },
      previous,
    );

    expect(result.findings).toEqual([]);
    expect(result.summary).toBe(
      'No new actionable defects were identified in the incremental changes.',
    );
  });

  it('preserves a finding at a new location', () => {
    const result = removePreviouslyReportedFindings(
      {
        ...previous,
        findings: [
          {
            ...previousFinding,
            file: 'src/server.mjs',
            line: 20,
          },
        ],
      },
      previous,
    );

    expect(result.findings).toHaveLength(1);
  });

  it('keeps a moved instance of the same semantic finding out of new findings', () => {
    const result = removePreviouslyReportedFindings(
      {
        ...previous,
        findings: [{ ...previousFinding, line: 20 }],
      },
      previous,
      new Set(['src/access.mjs']),
    );

    expect(result.findings).toHaveLength(0);
    expect(findingFingerprint(previousFinding)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('keeps inline findings out of the duplicated summary list', () => {
    const body = renderReview(previous, new Set([0]));

    expect(body).toContain('1 finding was published inline');
    expect(body).not.toContain('#### 🔴 [HIGH] Authorization comparison is inverted');
    expect(body).not.toContain('gpt-5.6-luna');
  });

  it('reports success only for an explicitly complete zero-finding review', () => {
    const noFindings = { ...previous, findings: [] };

    expect(reviewConclusion(noFindings)).toBe('neutral');
    expect(
      reviewConclusion({
        ...noFindings,
        coverage: {
          changed_files: ['src/access.mjs'],
          complete: false,
          omitted_files: ['src/access.mjs'],
          reviewed_files: [],
        },
      }),
    ).toBe('neutral');
    expect(
      reviewConclusion({
        ...noFindings,
        coverage: {
          changed_files: ['src/access.mjs'],
          complete: true,
          omitted_files: [],
          reviewed_files: ['src/access.mjs'],
        },
      }),
    ).toBe('success');
    expect(
      reviewConclusion({
        ...noFindings,
        coverage: {
          changed_files: ['src/access.mjs'],
          complete: true,
          omitted_files: [],
          reviewed_files: ['src/access.mjs'],
        },
        finding_updates: [
          {
            evidence: 'The inverted comparison remains.',
            fingerprint: 'a'.repeat(16),
            status: 'still_present',
          },
        ],
      }),
    ).toBe('neutral');
  });

  it('keeps changed-file coverage paths case-sensitive', () => {
    const result: ReviewResult = {
      ...previous,
      findings: [],
      coverage: {
        changed_files: ['Foo.ts', 'foo.ts'],
        complete: true,
        omitted_files: ['foo.ts'],
        reviewed_files: ['Foo.ts'],
      },
    };

    expect(reviewCoverage(result)).toEqual({
      changed: 2,
      omitted: 1,
      reviewed: 1,
      complete: false,
    });
    expect(reviewConclusion(result)).toBe('neutral');
  });

  it('keeps only unique, evidenced updates for supplied prior findings', () => {
    const fingerprint = findingFingerprint(previousFinding);
    const result = validateFindingUpdates(
      {
        ...previous,
        finding_updates: [
          { evidence: '  Fixed by the new guard.  ', fingerprint, status: 'fixed' },
          { evidence: 'duplicate', fingerprint, status: 'still_present' },
          { evidence: 'unknown', fingerprint: '0'.repeat(16), status: 'fixed' },
        ],
      },
      previous,
    );

    expect(result.finding_updates).toEqual([
      { evidence: 'Fixed by the new guard.', fingerprint, status: 'fixed' },
    ]);
    expect(result.limitations.at(-1)).toContain('Ignored invalid prior-finding updates');
  });

  it('rejects blank and oversized finding update evidence', () => {
    const fingerprint = findingFingerprint(previousFinding);
    const otherFinding = { ...previousFinding, title: 'A different prior defect' };
    const otherFingerprint = findingFingerprint(otherFinding);
    const result = validateFindingUpdates(
      {
        ...previous,
        finding_updates: [
          { evidence: '   ', fingerprint, status: 'fixed' },
          { evidence: '가'.repeat(2_000), fingerprint: otherFingerprint, status: 'fixed' },
        ],
      },
      { ...previous, findings: [previousFinding, otherFinding] },
    );

    expect(result.finding_updates).toEqual([]);
    expect(result.limitations.at(-1)).toContain('blank evidence');
    expect(result.limitations.at(-1)).toContain('evidence exceeds 4000 bytes');
  });
});

describe('review markdown checks', () => {
  const checks: ReviewResult['tests_run'] = [
    {
      command: 'pnpm contracts test',
      evidence: '4 tests passed.',
      status: 'passed',
    },
    {
      command: 'pnpm reviewer test',
      evidence: '90 tests passed.',
      status: 'passed',
    },
    {
      command: 'pnpm web test',
      evidence: '13 tests passed.',
      status: 'passed',
    },
  ];

  it('renders aggregate counts and one three-column table row per passed check', () => {
    const body = renderReview({ ...previous, tests_run: checks });

    expect(body).toContain('### Checks');
    expect(body).toContain('**3 passed · 0 failed · 0 not run**');
    expect(body).toContain('<details>');
    expect(body).not.toContain('<details open>');
    expect(body).toContain('<summary>Show 3 checks</summary>');
    expect(body).toContain('| Status | Check | Evidence |');
    expect(body.match(/^\| 🟢 \*\*passed\*\* \| `pnpm .*` \|/gm)).toHaveLength(3);
    expect(body).not.toContain('### Verification');
  });

  it('opens the disclosure when a check failed or was not run', () => {
    const body = renderReview({
      ...previous,
      tests_run: [
        ...checks,
        { command: 'pnpm deploy', evidence: 'Command failed.', status: 'failed' },
        { command: 'pnpm e2e', evidence: 'Skipped by CI.', status: 'not_run' },
      ],
    });

    expect(body).toContain('**3 passed · 1 failed · 1 not run**');
    expect(body).toContain('<details open>');
    expect(body).toContain('| 🔴 **failed** | `pnpm deploy` | Command failed. |');
    expect(body).toContain('| ⚪ **not run** | `pnpm e2e` | Skipped by CI. |');
  });

  it('renders an explicit empty state without an empty disclosure', () => {
    const body = renderReview({ ...previous, tests_run: [] });

    expect(body).toContain('### Checks\n\nNo checks were run.');
    expect(body).not.toContain('<details>');
  });

  it('preserves multiline check evidence while preserving findings and limitations', () => {
    const body = renderReview({
      ...previous,
      findings: [],
      limitations: ['The sandbox was unavailable.'],
      summary: 'No actionable defects.',
      tests_run: [
        {
          command: 'pnpm test | tee result.log',
          evidence: 'Output line one\nOutput | line two.',
          status: 'passed',
        },
      ],
    });

    expect(body).toContain(
      '| 🟢 **passed** | `pnpm test \\| tee result.log` | Output line one<br>Output \\| line two. |',
    );
    expect(body).toContain('### Findings\n\nNo actionable defects found.');
    expect(body).toContain('### Limitations\n\n- The sandbox was unavailable.');
  });

  it('keeps check commands ending in backticks inside a valid code span', () => {
    const body = renderReview({
      ...previous,
      tests_run: [{ command: 'echo `date`', evidence: 'Command passed.', status: 'passed' }],
    });

    expect(body).toContain('| 🟢 **passed** | `` echo `date` `` | Command passed. |');
  });
});
