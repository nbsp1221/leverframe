import { getTranslations } from 'next-intl/server';
import type { ReviewDataSource } from './review-data';
import { ReviewList } from './review-list';
import { ReviewOverview, type ReviewOverviewDependency } from './review-overview';

export async function ReviewDashboard({ data }: { data: ReviewDataSource }) {
  const t = await getTranslations('reviews');
  const reviews = data.reviews.kind === 'ok' ? data.reviews.data : null;
  const status = data.status.kind === 'ok' ? data.status.data : null;
  const metrics = data.metrics.kind === 'ok' ? data.metrics.data : null;
  const needsEvaluationResponse =
    data.needsEvaluation.kind === 'ok' ? data.needsEvaluation.data : null;
  const needsEvaluation = needsEvaluationResponse?.total_items ?? null;
  const nextReview = needsEvaluationResponse?.items[0];
  const stageSummary = status
    ? Object.entries(status.active_stages)
        .filter(([, count]) => count > 0)
        .map(([stage, count]) => `${t(`stage_${stage}`)} ${count}`)
        .join(' · ')
    : undefined;
  const dependencies: ReviewOverviewDependency[] = [
    { key: 'api', status: status?.api.status ?? null },
    { key: 'database', status: status?.database.status ?? null },
    { key: 'worker', status: status?.worker.status ?? null },
    { key: 'sandbox', status: status?.sandbox.status ?? null },
    { key: 'github', status: status?.github.status ?? null },
  ];

  return (
    <ReviewOverview
      health={status?.overall ?? null}
      dependencies={dependencies}
      activeJobs={status?.active_jobs ?? null}
      activeSummary={stageSummary}
      metrics={metrics}
      needsEvaluation={needsEvaluation}
      attentionHref="/reviews?evaluation=needs_evaluation"
      nextReviewHref={
        nextReview ? `/reviews/${nextReview.id}?evaluation=needs_evaluation` : undefined
      }
    >
      {reviews ? (
        <ReviewList response={reviews} error={data.reviews.kind !== 'ok'} />
      ) : (
        <ReviewList
          response={{ items: [], page: 1, page_size: 20, total_items: 0, total_pages: 0 }}
          error
        />
      )}
    </ReviewOverview>
  );
}
