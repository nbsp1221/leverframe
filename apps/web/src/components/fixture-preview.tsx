import type { ReviewDetail, ReviewMetricsResponse } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@repo/ui/components/empty';
import { Skeleton } from '@repo/ui/components/skeleton';
import { ActivityIcon, CircleXIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { ReviewDetailPage } from '../features/reviews/review-detail';
import { ReviewDetailNotFoundState } from '../features/reviews/review-detail-not-found';
import { ReviewList } from '../features/reviews/review-list';
import { ReviewOverview, type ReviewOverviewDependency } from '../features/reviews/review-overview';
import {
  type FixtureScenario,
  type FixtureState,
  createFixture,
  fixtureDetailResponse,
  fixtureEvaluationsResponse,
  fixtureListResponse,
  fixtureScenarios,
  isFixtureScenario,
} from '../fixtures';
import { Link } from '../i18n/navigation';
import { FixtureContextTransport } from './fixture-context-transport';
import { FixtureEvaluationTransport } from './fixture-evaluation-transport';
import { FixtureSelector } from './fixture-selector';

type FixturePreviewProps = {
  requestedScenario?: string | undefined;
  searchParams?: Record<string, string | string[] | undefined> | undefined;
  allowControls: boolean;
};

function fixtureMetrics(state: FixtureState): ReviewMetricsResponse {
  const terminal = state.reviews.filter(
    (review) => review.status === 'completed' || review.status === 'failed',
  );
  const completed = terminal.filter((review) => review.status === 'completed');
  const durations = completed
    .flatMap((review) => (review.duration_ms === null ? [] : [review.duration_ms]))
    .sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianDuration =
    durations.length === 0
      ? null
      : durations.length % 2 === 1
        ? (durations[middle] ?? null)
        : ((durations[middle - 1] ?? 0) + (durations[middle] ?? 0)) / 2;
  const averageDuration =
    durations.length === 0
      ? null
      : durations.reduce((sum, duration) => sum + duration, 0) / durations.length;
  const failed = terminal.length - completed.length;

  return {
    terminal_window_size: 50,
    terminal_sample_size: terminal.length,
    completed_sample_size: completed.length,
    failed_sample_size: failed,
    duration_sample_size: durations.length,
    average_duration_ms: averageDuration,
    median_duration_ms: medianDuration,
    failure_rate: terminal.length === 0 ? null : failed / terminal.length,
  };
}

export async function FixturePreview({
  requestedScenario,
  searchParams,
  allowControls,
}: FixturePreviewProps) {
  const t = await getTranslations('reviews');
  const scenario: FixtureScenario =
    allowControls && isFixtureScenario(requestedScenario) ? requestedScenario : 'default';
  const state = createFixture(scenario);
  const activeJobs = state.activeReview
    ? 1
    : state.reviews.filter((item) => item.status === 'running').length;
  const metrics = fixtureMetrics(state);
  const reviewsNeedingEvaluation = state.reviews.filter(
    (item) => item.status === 'completed' && item.review_evaluation === null,
  );
  const needsEvaluation = reviewsNeedingEvaluation.length;
  const nextReview = reviewsNeedingEvaluation[0];
  const dependencies: ReviewOverviewDependency[] = [
    { key: 'api', status: state.health.dependencies.api },
    { key: 'database', status: state.health.overall },
    { key: 'worker', status: state.health.dependencies.worker },
    { key: 'sandbox', status: state.health.dependencies.sandbox },
    { key: 'github', status: state.health.dependencies.github },
  ];
  const fixtureQuery = `fixture=${scenario}`;

  return (
    <ReviewOverview
      health={state.health.overall}
      dependencies={dependencies}
      activeJobs={activeJobs}
      activeSummary={state.activeReview ? t(state.activeReview.status) : t('activeSummary')}
      metrics={metrics}
      needsEvaluation={needsEvaluation}
      attentionHref={`/reviews?${fixtureQuery}&evaluation=needs_evaluation`}
      nextReviewHref={
        nextReview
          ? `/reviews/${nextReview.id}?${fixtureQuery}&evaluation=needs_evaluation`
          : undefined
      }
      controls={
        allowControls ? (
          <FixtureSelector
            scenario={scenario}
            label={t('fixture')}
            applyLabel={t('fixtureApply')}
            scenarios={fixtureScenarios}
          />
        ) : undefined
      }
    >
      <ReviewState state={state} t={t} searchParams={searchParams} />
    </ReviewOverview>
  );
}

export function FixtureDetailPreview({
  requestedScenario,
  reviewId,
  allowControls,
  returnQuery,
}: {
  requestedScenario?: string | undefined;
  reviewId: number;
  allowControls: boolean;
  returnQuery?: string;
}) {
  const scenario: FixtureScenario =
    allowControls && isFixtureScenario(requestedScenario) ? requestedScenario : 'default';
  const state = createFixture(scenario);
  const detail = fixtureDetailResponse(state, reviewId);
  if (!detail) {
    return <ReviewDetailNotFoundState returnQuery={returnQuery} />;
  }
  const resolvedDetail: ReviewDetail = detail;
  const transportMode =
    scenario === 'saving-evaluation' || scenario === 'evaluation-save-failure'
      ? scenario === 'saving-evaluation'
        ? 'saving'
        : 'failure'
      : undefined;
  const contextMode =
    scenario === 'context-available' ||
    scenario === 'context-unavailable' ||
    scenario === 'context-loading' ||
    scenario === 'context-error'
      ? (scenario.replace('context-', '') as 'available' | 'unavailable' | 'loading' | 'error')
      : undefined;
  return (
    <FixtureContextTransport mode={contextMode}>
      <FixtureEvaluationTransport mode={transportMode}>
        <ReviewDetailPage
          detail={resolvedDetail}
          returnQuery={returnQuery}
          evaluations={fixtureEvaluationsResponse(state, reviewId) ?? null}
        />
      </FixtureEvaluationTransport>
    </FixtureContextTransport>
  );
}

function ReviewState({
  state,
  t,
  searchParams,
}: {
  state: FixtureState;
  t: (key: string) => string;
  searchParams?: Record<string, string | string[] | undefined> | undefined;
}) {
  if (state.listState === 'loading') {
    return (
      <section className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="text-base font-bold">{t('reviewQueue')}</h2>
        <div className="mt-4 flex flex-col gap-3">
          <Skeleton className="h-10 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-full rounded-xl" />
          <Skeleton className="h-16 w-3/4 rounded-xl" />
        </div>
      </section>
    );
  }
  if (state.listState === 'error') {
    return (
      <Alert variant="destructive" className="rounded-2xl bg-surface p-5">
        <CircleXIcon aria-hidden="true" />
        <AlertTitle>{t('errorTitle')}</AlertTitle>
        <AlertDescription>{t('errorDescription')}</AlertDescription>
        <Link
          className="mt-2 inline-flex text-sm font-semibold underline underline-offset-4"
          href="/reviews"
        >
          {t('retry')}
        </Link>
      </Alert>
    );
  }
  if (state.listState === 'empty' || state.listState === 'filtered-empty') {
    return (
      <Empty className="rounded-2xl border border-dashed border-border bg-surface">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ActivityIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {state.listState === 'empty' ? t('emptyTitle') : t('filteredEmptyTitle')}
          </EmptyTitle>
          <EmptyDescription>
            {state.listState === 'empty' ? t('emptyDescription') : t('filteredEmptyDescription')}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const value = (key: string) => {
    const raw = searchParams?.[key];
    return Array.isArray(raw) ? raw[0] : raw;
  };

  return (
    <ReviewList
      detailScenario={state.scenario}
      response={fixtureListResponse(state, {
        page: Number(value('page')) || 1,
        query: value('query'),
        status: value('status'),
        evaluation: value('evaluation'),
      })}
    />
  );
}
