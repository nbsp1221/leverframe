'use client';

import type { ReviewListItem } from '@repo/contracts';
import type { tableFeatures } from '@tanstack/react-table';
import { Button } from '@repo/ui/components/button';
import { createColumnHelper } from '@tanstack/react-table';
import { ExternalLinkIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link } from '../../i18n/navigation';
import { formatDuration } from './review-format';

type Translation = (key: string, values?: Record<string, number>) => string;
type TableFeatures = ReturnType<typeof tableFeatures>;

const columnHelper = createColumnHelper<TableFeatures, ReviewListItem>();

export function createReviewColumns(
  t: Translation,
  common: Translation,
  detailScenario?: string,
  returnQuery?: string,
) {
  return [
    columnHelper.display({
      id: 'repository',
      header: () => t('reviewColumn'),
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => {
        const item = row.original;
        return (
          <Link
            href={`/reviews/${item.id}${returnQuery ? `?${returnQuery}` : detailScenario ? `?fixture=${detailScenario}` : ''}`}
            className="group block min-w-0 py-0.5"
            onClick={(event) => event.stopPropagation()}
          >
            <p className="truncate text-base font-semibold tracking-[-0.015em] text-foreground transition-colors group-hover:text-link">
              {item.pull_request_title ?? t('untitled')}
            </p>
            <p className="mt-0.5 truncate text-xs text-muted-foreground">
              {item.repository} · PR #{item.pull_request_number}
            </p>
          </Link>
        );
      },
    }),
    columnHelper.display({
      id: 'status',
      header: () => common('status'),
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => <StatusSignal status={row.original.status} t={t} />,
    }),
    columnHelper.display({
      id: 'findings',
      header: () => t('issues'),
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => <FindingSummary item={row.original} t={t} />,
    }),
    columnHelper.display({
      id: 'evaluation',
      header: () => t('evaluation'),
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => <EvaluationSummary item={row.original} t={t} />,
    }),
    columnHelper.display({
      id: 'duration',
      header: () => t('duration'),
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => (
        <span className="text-sm tabular-nums text-foreground">
          {formatDuration(row.original.duration_ms)}
        </span>
      ),
    }),
    columnHelper.display({
      id: 'actions',
      header: () => '',
      // oxlint-disable-next-line react/no-unstable-nested-components
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon-sm"
          nativeButton={false}
          className="rounded-lg text-muted-foreground hover:text-foreground"
          aria-label={t('openGitHub')}
          onClick={(event) => event.stopPropagation()}
          render={
            <a
              href={`https://github.com/${row.original.repository}/pull/${row.original.pull_request_number}`}
              target="_blank"
              rel="noreferrer"
            />
          }
        >
          <ExternalLinkIcon aria-hidden="true" />
        </Button>
      ),
    }),
  ];
}

export function columnClass(id: string) {
  if (id === 'repository') {
    return 'w-[44%] min-w-[18rem]';
  }
  if (id === 'status') {
    return 'w-[12%]';
  }
  if (id === 'findings') {
    return 'w-[11%]';
  }
  if (id === 'evaluation') {
    return 'w-[18%]';
  }
  if (id === 'duration') {
    return 'w-[11%]';
  }
  if (id === 'actions') {
    return 'w-10 text-right';
  }
  return undefined;
}

export function StatusSignal({ status, t }: { status: string; t: Translation }) {
  const tone =
    status === 'completed'
      ? 'text-success'
      : status === 'running' || status === 'queued'
        ? 'text-info'
        : status === 'failed'
          ? 'text-danger'
          : 'text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-2 text-xs font-semibold ${tone}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {t(status)}
    </span>
  );
}

export function FindingSummary({ item, t }: { item: ReviewListItem; t: Translation }) {
  if (item.findings_count === null) {
    return <span className="text-sm text-muted-foreground">—</span>;
  }
  const tone =
    item.highest_severity === 'critical' || item.highest_severity === 'high'
      ? 'text-danger'
      : item.highest_severity === 'medium'
        ? 'text-warning'
        : 'text-foreground';
  return (
    <div className={tone}>
      <span className="text-sm font-semibold tabular-nums">{item.findings_count}</span>
      {item.highest_severity ? (
        <span className="mt-0.5 block text-xs font-medium">{t(item.highest_severity)}</span>
      ) : null}
    </div>
  );
}

export function EvaluationSummary({ item, t }: { item: ReviewListItem; t: Translation }) {
  if (item.review_evaluation) {
    return (
      <div>
        <span className="text-sm font-medium text-foreground">{t(item.review_evaluation)}</span>
        {item.total_findings > 0 ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {item.evaluated_findings}/{item.total_findings}
          </span>
        ) : null}
      </div>
    );
  }
  if (item.status === 'completed') {
    return (
      <div>
        <span className="text-sm font-medium text-foreground">{t('needsReview')}</span>
        {item.total_findings > 0 ? (
          <span className="mt-0.5 block text-xs text-muted-foreground">
            {item.evaluated_findings}/{item.total_findings}
          </span>
        ) : null}
      </div>
    );
  }
  return <span className="text-sm text-muted-foreground">—</span>;
}

export function RelativeTime({ value }: { value: string | null }) {
  const t = useTranslations('reviews');
  const [now, setNow] = useState<number | null>(null);
  // Relative labels intentionally hydrate after the stable server-rendered timestamp.
  // eslint-disable-next-line @eslint-react/set-state-in-effect
  useEffect(() => setNow(Date.now()), []);
  if (!value) {
    return <>—</>;
  }
  return (
    <time dateTime={value} title={value}>
      {now === null ? '—' : formatRelativeTime(value, now, t)}
    </time>
  );
}

function formatRelativeTime(value: string, now: number, t: Translation): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(value)) / 60_000);
  if (minutes < 1) {
    return t('relativeNow');
  }
  if (minutes < 60) {
    return t('relativeMinutes', { count: minutes });
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return t('relativeHours', { count: hours });
  }
  return t('relativeDays', { count: Math.floor(hours / 24) });
}
