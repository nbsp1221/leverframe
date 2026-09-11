import {
  type ReviewListResponse,
  type ReviewMetricsResponse,
  type StatusResponse,
  reviewListResponseSchema,
  reviewMetricsResponseSchema,
  statusResponseSchema,
} from '@repo/contracts';
import { reviewEvaluationValues, reviewStatusValues } from './review-query';

export type ReviewDataError =
  | { kind: 'missing-config' }
  | { kind: 'config-error' }
  | { kind: 'http-error'; status: number }
  | { kind: 'network-error' }
  | { kind: 'schema-error' };

export type ReviewDataResult<T> = { kind: 'ok'; data: T } | ReviewDataError;

export type ReviewDataSource = {
  reviews: ReviewDataResult<ReviewListResponse>;
  status: ReviewDataResult<StatusResponse>;
  metrics: ReviewDataResult<ReviewMetricsResponse>;
  needsEvaluation: ReviewDataResult<ReviewListResponse>;
};

export function toReviewerQuery(search: URLSearchParams): URLSearchParams {
  const query = new URLSearchParams();
  const searchQuery = search.get('query')?.trim();
  if (searchQuery) {
    query.set('query', searchQuery);
  }
  const status = search.get('status');
  if (
    status &&
    reviewStatusValues.includes(status as (typeof reviewStatusValues)[number]) &&
    status !== 'all'
  ) {
    query.set('status', status);
  }
  const evaluation = search.get('evaluation');
  if (
    evaluation &&
    reviewEvaluationValues.includes(evaluation as (typeof reviewEvaluationValues)[number]) &&
    evaluation !== 'all'
  ) {
    query.set('evaluation', evaluation);
  }
  const page = Number(search.get('page'));
  if (Number.isSafeInteger(page) && page > 0) {
    query.set('page', String(page));
  }
  query.set('page_size', '20');
  return query;
}

async function fetchReviews(
  base: URL,
  query: URLSearchParams,
): Promise<ReviewDataResult<ReviewListResponse>> {
  try {
    const url = new URL('api/v1/reviews', base);
    url.search = query.toString();
    const response = await fetch(url, {
      cache: 'no-store',
    });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = reviewListResponseSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

async function fetchStatus(base: URL): Promise<ReviewDataResult<StatusResponse>> {
  try {
    const response = await fetch(new URL('api/v1/status', base), { cache: 'no-store' });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = statusResponseSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

async function fetchMetrics(base: URL): Promise<ReviewDataResult<ReviewMetricsResponse>> {
  try {
    const response = await fetch(new URL('api/v1/reviews/metrics', base), { cache: 'no-store' });
    if (!response.ok) {
      return { kind: 'http-error', status: response.status };
    }
    const parsed = reviewMetricsResponseSchema.safeParse(await response.json());
    return parsed.success ? { kind: 'ok', data: parsed.data } : { kind: 'schema-error' };
  } catch {
    return { kind: 'network-error' };
  }
}

export async function getReviewData(search: URLSearchParams): Promise<ReviewDataSource> {
  const configuredBase = process.env.REVIEWER_INTERNAL_URL;
  if (!configuredBase) {
    const missingConfig: ReviewDataError = { kind: 'missing-config' };
    return {
      reviews: missingConfig,
      status: missingConfig,
      metrics: missingConfig,
      needsEvaluation: missingConfig,
    };
  }
  let base: URL;
  try {
    base = new URL(`${configuredBase.replace(/\/+$/, '')}/`);
    if (!['http:', 'https:'].includes(base.protocol)) {
      throw new Error('reviewer URL must use http or https');
    }
  } catch {
    const configError: ReviewDataError = { kind: 'config-error' };
    return {
      reviews: configError,
      status: configError,
      metrics: configError,
      needsEvaluation: configError,
    };
  }
  const currentQuery = toReviewerQuery(search);
  const needsEvaluationQuery = new URLSearchParams({
    evaluation: 'needs_evaluation',
    page: '1',
    page_size: '20',
  });
  const [reviews, status, metrics, needsEvaluation] = await Promise.all([
    fetchReviews(base, currentQuery),
    fetchStatus(base),
    fetchMetrics(base),
    fetchReviews(base, needsEvaluationQuery),
  ]);
  return { reviews, status, metrics, needsEvaluation };
}
