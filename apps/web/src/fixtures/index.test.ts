import { reviewDetailSchema } from '@repo/contracts';
import { describe, expect, it } from 'vitest';
import en from '../../messages/en.json';
import ko from '../../messages/ko.json';
import { healthDescriptionKey } from './health';
import {
  createFixture,
  fixtureDetailResponse,
  fixtureEvaluationsResponse,
  fixtureListResponse,
  fixtureScenarios,
  isFixtureControlEnabled,
} from './index';

describe('fixture harness', () => {
  it('creates every named scenario with a typed shell state', () => {
    for (const scenario of fixtureScenarios) {
      expect(createFixture(scenario).fixtureOnly).toBe(true);
    }
  });

  it('does not enable fixture controls in production', () => {
    expect(isFixtureControlEnabled('production')).toBe(false);
    expect(isFixtureControlEnabled('development')).toBe(true);
  });

  it('keeps loading, empty, and error states distinct', () => {
    expect(createFixture('loading').listState).toBe('loading');
    expect(createFixture('empty-history').listState).toBe('empty');
    expect(createFixture('list-error').listState).toBe('error');
  });

  it('maps every health status to an existing localized reviews message', () => {
    const statuses = ['healthy', 'degraded', 'unavailable'] as const;
    for (const status of statuses) {
      const key = healthDescriptionKey(status);
      expect(en.reviews[key]).toBeTruthy();
      expect(ko.reviews[key]).toBeTruthy();
    }
  });

  it('localizes every detail lifecycle notice in both supported languages', () => {
    const statuses = ['running', 'failed', 'superseded', 'queued', 'cancelled', 'unknown'] as const;
    for (const status of statuses) {
      const key = `${status}Description` as const;
      expect(en.reviewDetail[key]).toBeTruthy();
      expect(ko.reviewDetail[key]).toBeTruthy();
    }
  });

  it('paginates fixture responses and keeps named active reviews visible', () => {
    const pageTwo = fixtureListResponse(createFixture('pagination'), { page: 2 });
    expect(pageTwo.page).toBe(2);
    expect(pageTwo.items).toHaveLength(4);
    expect(pageTwo.items[0]?.id).toBe(221);

    const running = fixtureListResponse(createFixture('running'));
    expect(running.items[0]?.id).toBe(240);
    expect(running.items[0]?.status).toBe('running');
  });

  it('uses the public evaluation taxonomy when applying fixture filters', () => {
    const state = createFixture('default');
    const needsEvaluation = fixtureListResponse(state, { evaluation: 'needs_evaluation' });
    expect(needsEvaluation.items.every((item) => item.status === 'completed')).toBe(true);
    expect(needsEvaluation.items.every((item) => item.review_evaluation === null)).toBe(true);
  });

  it('creates read-only detail contracts for named lifecycle scenarios', () => {
    const scenarios = [
      ['running', 240, 'running', false],
      ['failed', 237, 'failed', false],
      ['superseded', 239, 'superseded', false],
      ['completed-zero-findings', 235, 'completed', true],
      ['missing-artifact', 234, 'completed', false],
      ['incomplete-coverage', 234, 'completed', true],
      ['queued', 232, 'queued', false],
      ['cancelled', 231, 'cancelled', false],
      ['unknown', 230, 'unknown', false],
    ] as const;
    for (const [scenario, id, status, artifactAvailable] of scenarios) {
      const detail = fixtureDetailResponse(createFixture(scenario), id);
      expect(detail).toBeDefined();
      const parsed = reviewDetailSchema.parse(detail);
      expect(parsed.status).toBe(status);
      expect(parsed.artifact.available).toBe(artifactAvailable);
      if (!artifactAvailable) {
        expect(parsed.artifact.findings).toEqual([]);
        expect(parsed.artifact.coverage).toBeNull();
        expect(parsed.artifact.tests_run).toEqual([]);
      }
    }
  });

  it('creates a many-finding stress fixture with a mixed severity distribution', () => {
    const detail = fixtureDetailResponse(createFixture('stress-many-findings'), 241);
    expect(detail?.artifact.findings).toHaveLength(10);
    expect(detail?.artifact.findings.map((finding) => finding.severity)).toEqual([
      'high',
      'medium',
      'medium',
      'medium',
      'low',
      'low',
      'low',
      'low',
      'low',
      'low',
    ]);
  });

  it('keeps finding lifecycle states in the stored detail contract', () => {
    expect(
      fixtureDetailResponse(createFixture('finding-open'), 229)?.artifact.findings[0]?.state,
    ).toBe('open');
    expect(
      fixtureDetailResponse(createFixture('finding-fixed'), 229)?.artifact.findings[0]?.state,
    ).toBe('fixed');
    expect(
      fixtureDetailResponse(createFixture('finding-fixed'), 229)?.artifact.findings[0]
        ?.thread_resolution?.state,
    ).toBe('resolved');
    expect(
      fixtureDetailResponse(createFixture('finding-still-present'), 229)?.artifact.findings[0]
        ?.state,
    ).toBe('still_present');
  });

  it('provides typed evaluation histories for the interactive detail fixtures', () => {
    const evaluations = fixtureEvaluationsResponse(createFixture('evaluation-history'), 241);
    expect(evaluations?.review.history.map((revision) => revision.id)).toEqual([2, 1]);
    expect(evaluations?.review.current?.verdict).toBe('mixed');
    expect(fixtureEvaluationsResponse(createFixture('not-evaluated'), 241)?.review.history).toEqual(
      [],
    );
  });
});
