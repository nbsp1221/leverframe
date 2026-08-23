import { describe, expect, it } from 'vitest';
import {
  deleteEvaluationRequestSchema,
  findingEvaluationWriteRequestSchema,
  findingParamsSchema,
  reviewEvaluationWriteRequestSchema,
  reviewFindingSchema,
  reviewIdParamsSchema,
  reviewListQuerySchema,
} from '../src/index.js';

describe('review API request contracts', () => {
  it('normalizes documented pagination and rejects unsupported page sizes', () => {
    expect(reviewListQuerySchema.parse({})).toMatchObject({
      page: 1,
      page_size: 20,
      sort: 'created',
    });
    expect(reviewListQuerySchema.parse({ page: '2', page_size: '20' }).page).toBe(2);
    expect(reviewListQuerySchema.safeParse({ page_size: '100' }).success).toBe(false);
    expect(reviewListQuerySchema.parse({ status: ['completed', 'failed'] }).status).toEqual([
      'completed',
      'failed',
    ]);
    expect(reviewListQuerySchema.safeParse({ status: 'completed, failed' }).success).toBe(true);
    expect(
      reviewListQuerySchema.safeParse({ status: ['completed,failed', 'superseded'] }).success,
    ).toBe(true);
    expect(reviewListQuerySchema.parse({ status: 'Completed, FAILED' }).status).toBe(
      'completed, failed',
    );
    expect(reviewListQuerySchema.safeParse({ status: 'unknown' }).success).toBe(false);
    expect(reviewListQuerySchema.safeParse({ status: 'arbitrary' }).success).toBe(false);
  });

  it('coerces positive review IDs and validates finding fingerprints', () => {
    expect(reviewIdParamsSchema.parse({ reviewId: '42' })).toEqual({ reviewId: 42 });
    expect(reviewIdParamsSchema.safeParse({ reviewId: '0' }).success).toBe(false);
    expect(findingParamsSchema.parse({ reviewId: '42', fingerprint: '0123456789abcdef' })).toEqual({
      reviewId: 42,
      fingerprint: '0123456789abcdef',
    });
    expect(
      findingParamsSchema.safeParse({ reviewId: '42', fingerprint: 'not-a-fingerprint' }).success,
    ).toBe(false);
  });

  it('keeps review and finding verdict taxonomies separate', () => {
    const common = { expected_previous_id: null, rationale: 'Human-approved evidence.' };
    expect(
      reviewEvaluationWriteRequestSchema.safeParse({ ...common, verdict: 'useful' }).success,
    ).toBe(true);
    expect(
      reviewEvaluationWriteRequestSchema.safeParse({ ...common, verdict: 'false_positive' })
        .success,
    ).toBe(false);
    expect(
      findingEvaluationWriteRequestSchema.safeParse({ ...common, verdict: 'false_positive' })
        .success,
    ).toBe(true);
    expect(
      findingEvaluationWriteRequestSchema.safeParse({ ...common, verdict: 'useful' }).success,
    ).toBe(false);
  });

  it('validates GitHub thread resolution state separately from finding state', () => {
    const finding = {
      fingerprint: '0123456789abcdef',
      severity: 'high',
      confidence: 'high',
      title: 'A finding',
      explanation: 'Explanation',
      suggested_action: 'Fix it',
      evidence: 'Evidence',
      file: 'src/example.ts',
      line: 12,
      state: 'fixed',
      thread_resolution: {
        state: 'resolved',
        resolved_at: '2026-08-23T00:00:00.000Z',
        resolved_head_sha: 'a'.repeat(40),
        last_error: null,
      },
      evaluation: null,
    };
    expect(reviewFindingSchema.parse(finding).thread_resolution?.state).toBe('resolved');
    expect(
      reviewFindingSchema.safeParse({
        ...finding,
        thread_resolution: { ...finding.thread_resolution, state: 'unknown' },
      }).success,
    ).toBe(false);
  });

  it('requires an explicit concurrency revision and bounds rationale length', () => {
    expect(reviewEvaluationWriteRequestSchema.safeParse({ verdict: 'useful' }).success).toBe(false);
    expect(
      reviewEvaluationWriteRequestSchema.safeParse({
        verdict: 'useful',
        rationale: 'a'.repeat(4_000),
        expected_previous_id: null,
      }).success,
    ).toBe(true);
    expect(
      reviewEvaluationWriteRequestSchema.safeParse({
        verdict: 'useful',
        rationale: 'a'.repeat(4_001),
        expected_previous_id: null,
      }).success,
    ).toBe(false);
    expect(deleteEvaluationRequestSchema.parse({ expected_previous_id: 7 })).toEqual({
      expected_previous_id: 7,
    });
    expect(deleteEvaluationRequestSchema.safeParse({}).success).toBe(false);
  });
});
