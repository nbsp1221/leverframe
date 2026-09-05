import type { DependencyStatus, ReviewMetricsResponse } from '@repo/contracts';
import type { ReactNode } from 'react';
import { Button } from '@repo/ui/components/button';
import { AlertCircleIcon, CheckCircle2Icon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { formatDuration } from './review-format';
import { ReviewPageFrame } from './review-page-frame';

type DependencyKey = 'api' | 'database' | 'worker' | 'sandbox' | 'github';

export type ReviewOverviewDependency = {
  key: DependencyKey;
  status: DependencyStatus | null;
};

type ReviewOverviewProps = {
  health: DependencyStatus | null;
  dependencies: ReviewOverviewDependency[];
  activeJobs: number | null;
  activeSummary?: string | undefined;
  metrics: ReviewMetricsResponse | null;
  needsEvaluation: number | null;
  attentionHref: string;
  nextReviewHref?: string | undefined;
  controls?: ReactNode;
  children: ReactNode;
};

export async function ReviewOverview({
  health,
  dependencies,
  activeJobs,
  activeSummary,
  metrics,
  needsEvaluation,
  attentionHref,
  nextReviewHref,
  controls,
  children,
}: ReviewOverviewProps) {
  const t = await getTranslations('reviews');
  const healthStatus = health ?? 'unavailable';

  return (
    <ReviewPageFrame className="flex flex-col gap-6 lg:gap-7">
      {controls}

      <header className="px-0.5">
        <h1 className="text-3xl font-bold tracking-[-0.045em]">{t('title')}</h1>
        <p className="mt-1.5 text-sm text-muted-foreground">{t('subtitle')}</p>
      </header>

      <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
        <div className="grid sm:grid-cols-3 xl:grid-cols-[minmax(28rem,1.75fr)_repeat(3,minmax(10rem,0.62fr))]">
          <div className="flex min-h-36 flex-col justify-center border-b border-border/75 px-6 py-6 sm:col-span-3 sm:px-7 xl:col-span-1 xl:border-r xl:border-b-0 xl:px-8">
            <p className="text-sm font-semibold text-muted-foreground">{t('mostImportant')}</p>
            <p className="mt-2 max-w-3xl text-2xl font-bold tracking-[-0.04em] sm:text-3xl">
              <AttentionMessage count={needsEvaluation} />
            </p>
            {needsEvaluation !== null && needsEvaluation > 0 ? (
              <div className="mt-4">
                <Button
                  nativeButton={false}
                  className="h-10 rounded-xl px-4 text-sm font-semibold text-primary-foreground hover:text-primary-foreground"
                  render={<Link href={nextReviewHref ?? attentionHref} />}
                >
                  {nextReviewHref ? t('nextReview') : t('showReviewsToCheck')}
                </Button>
              </div>
            ) : null}
          </div>
          <HeroMetric
            label={t('active')}
            value={activeJobs === null ? '—' : t('reviewCount', { count: activeJobs })}
            description={activeSummary || t('activeSummary')}
            tone={activeJobs && activeJobs > 0 ? 'info' : 'default'}
          />
          <HeroMetric
            label={t('typicalDuration')}
            value={formatDuration(metrics?.median_duration_ms ?? null)}
            description={
              metrics && metrics.duration_sample_size > 0
                ? t('durationMetricDescription', {
                    count: metrics.duration_sample_size,
                    average: formatDuration(metrics.average_duration_ms),
                  })
                : t('metricUnavailable')
            }
          />
          <HeroMetric
            label={t('failureRate')}
            value={formatFailureRate(metrics?.failure_rate ?? null)}
            description={
              metrics && metrics.terminal_sample_size > 0
                ? t('failureMetricDescription', { count: metrics.terminal_sample_size })
                : t('metricUnavailable')
            }
            last
          />
        </div>
      </section>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">{children}</div>
        <aside className="min-w-0" aria-label={t('reviewSidebar')}>
          <SystemStatus health={healthStatus} dependencies={dependencies} />
        </aside>
      </div>
    </ReviewPageFrame>
  );
}

function formatFailureRate(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

async function AttentionMessage({ count }: { count: number | null }) {
  const t = await getTranslations('reviews');
  if (count === null) {
    return t('attentionHeroUnknown');
  }
  if (count === 0) {
    return t('attentionHeroZero');
  }
  return t('attentionHero', { count });
}

function HeroMetric({
  label,
  value,
  description,
  tone = 'default',
  last = false,
}: {
  label: string;
  value: string;
  description: ReactNode;
  tone?: 'default' | 'info';
  last?: boolean;
}) {
  return (
    <div
      className={`min-w-0 px-5 py-5 sm:flex sm:min-h-36 sm:flex-col sm:justify-center sm:py-6 ${last ? '' : 'border-b border-border/75 sm:border-r sm:border-b-0'} ${tone === 'info' ? 'text-info' : ''}`}
    >
      <p className="text-xs font-semibold text-muted-foreground sm:truncate">{label}</p>
      <p className="mt-1.5 text-xl font-bold tracking-[-0.025em] tabular-nums sm:truncate">
        {value}
      </p>
      <div className="mt-1 text-xs text-muted-foreground sm:truncate">{description}</div>
    </div>
  );
}

async function SystemStatus({
  health,
  dependencies,
}: {
  health: DependencyStatus;
  dependencies: ReviewOverviewDependency[];
}) {
  const t = await getTranslations('reviews');
  const common = await getTranslations('common');
  const healthy = health === 'healthy';
  const Icon = healthy ? CheckCircle2Icon : AlertCircleIcon;
  const tone = healthy
    ? 'bg-success-soft text-success'
    : health === 'degraded' || health === 'unknown'
      ? 'bg-warning-soft text-warning'
      : 'bg-danger-soft text-danger';

  return (
    <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <div className="flex items-start gap-3 border-b border-border/70 p-5">
        <span className={`grid size-9 shrink-0 place-items-center rounded-xl ${tone}`}>
          <Icon aria-hidden="true" className="size-4.5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-base font-bold tracking-[-0.02em]">{t('systemStatus')}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {healthy ? t('systemHealthy') : t('systemNeedsAttention')}
          </p>
        </div>
      </div>
      <div className="divide-y divide-border/70 px-5">
        {dependencies.map((dependency) => (
          <div
            key={dependency.key}
            className="flex min-h-10 items-center justify-between gap-3 py-2.5"
          >
            <span className="text-sm text-muted-foreground">{common(dependency.key)}</span>
            <DependencySignal
              status={dependency.status}
              label={common(dependency.status ?? 'unavailable')}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function DependencySignal({ status, label }: { status: DependencyStatus | null; label: string }) {
  const tone =
    status === 'healthy'
      ? 'text-success'
      : status === 'degraded' || status === 'unknown'
        ? 'text-warning'
        : 'text-danger';
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-semibold ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {label}
    </span>
  );
}
