import { ReviewDetailPage } from '../../../../src/features/reviews/review-detail';
import {
  getReviewDetail,
  getReviewEvaluations,
} from '../../../../src/features/reviews/review-detail-data';
import { ReviewDetailErrorState } from '../../../../src/features/reviews/review-detail-error';
import { reviewReturnQuery } from '../../../../src/features/reviews/review-detail-navigation';
import { ReviewDetailNotFoundState } from '../../../../src/features/reviews/review-detail-not-found';

export default async function ReviewDetailRoute({
  params,
  searchParams,
}: {
  params: Promise<{ reviewId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ reviewId }, query] = await Promise.all([params, searchParams]);
  const returnQuery = reviewReturnQuery(query);
  const numericId = Number(reviewId);
  if (!Number.isSafeInteger(numericId) || numericId <= 0) {
    return <ReviewDetailNotFoundState returnQuery={returnQuery} />;
  }
  const fixture = typeof query.fixture === 'string' ? query.fixture : undefined;
  const prototype =
    process.env.NODE_ENV === 'development' &&
    (query.prototype === 'single' || query.prototype === 'rail')
      ? query.prototype
      : undefined;
  const concept =
    process.env.NODE_ENV === 'development' &&
    (query.concept === 'toss-first' || query.concept === 'desktop')
      ? query.concept
      : undefined;
  const useFixture =
    process.env.NODE_ENV === 'development' &&
    (fixture !== undefined || process.env.REVIEWER_INTERNAL_URL === undefined);
  if (useFixture) {
    const { FixtureDetailPreview } = await import('../../../../src/components/fixture-preview');
    return (
      <FixtureDetailPreview
        requestedScenario={fixture}
        reviewId={numericId}
        allowControls
        returnQuery={returnQuery}
      />
    );
  }
  const [result, evaluations] = await Promise.all([
    getReviewDetail(reviewId),
    getReviewEvaluations(reviewId),
  ]);
  if (result.kind === 'http-error' && result.status === 404) {
    return <ReviewDetailNotFoundState returnQuery={returnQuery} />;
  }
  if (result.kind !== 'ok') {
    return (
      <ReviewDetailErrorState kind={result.kind} reviewId={reviewId} returnQuery={returnQuery} />
    );
  }
  const evaluationData = evaluations.kind === 'ok' ? evaluations.data : null;
  if (concept && result.data.status === 'completed' && result.data.artifact.available) {
    const { ReviewDetailConcept } =
      await import('../../../../src/features/reviews/review-detail-concepts');
    return (
      <ReviewDetailConcept
        detail={result.data}
        evaluations={evaluationData}
        concept={concept}
        returnQuery={returnQuery}
      />
    );
  }
  if (prototype) {
    const { ReviewDetailPrototype } =
      await import('../../../../src/features/reviews/review-detail-prototype');
    return (
      <ReviewDetailPrototype
        detail={result.data}
        evaluations={evaluationData}
        layout={prototype}
        returnQuery={returnQuery}
      />
    );
  }
  return (
    <ReviewDetailPage detail={result.data} returnQuery={returnQuery} evaluations={evaluationData} />
  );
}
