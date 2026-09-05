'use client';

import type { ReviewListItem, ReviewListResponse } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Button } from '@repo/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@repo/ui/components/empty';
import { Input } from '@repo/ui/components/input';
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@repo/ui/components/pagination';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/table';
import { flexRender, tableFeatures, useTable } from '@tanstack/react-table';
import { AlertCircleIcon, ExternalLinkIcon, SearchIcon, SlidersHorizontalIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { useQueryStates } from 'nuqs';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { Link, usePathname, useRouter } from '../../i18n/navigation';
import { reviewReturnQuery } from './review-detail-navigation';
import { formatDuration } from './review-format';
import {
  EvaluationSummary,
  FindingSummary,
  StatusSignal,
  columnClass,
  createReviewColumns,
} from './review-list-columns';
import { reviewQueryParsers } from './review-query-parsers';

type ReviewListProps = {
  response: ReviewListResponse;
  error?: boolean;
  detailScenario?: string;
};

const features = tableFeatures({});

export function ReviewList({ response, error = false, detailScenario }: ReviewListProps) {
  const t = useTranslations('reviews');
  const common = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const locale = useLocale();
  const searchParams = useSearchParams();
  const returnQuery = reviewReturnQuery(searchParams);
  const [{ query, status, evaluation }, setQuery] = useQueryStates(
    {
      ...reviewQueryParsers,
    },
    { shallow: false },
  );
  const [draftQuery, setDraftQuery] = useState(query);
  const [showFilters, setShowFilters] = useState(false);

  // URL state is authoritative after navigation; synchronize the controlled input once.
  // eslint-disable-next-line @eslint-react/set-state-in-effect
  useEffect(() => setDraftQuery(query), [query]);
  useEffect(() => {
    if (draftQuery === query) {
      return;
    }
    const timer = window.setTimeout(() => {
      void setQuery({ query: draftQuery || null, page: null });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [draftQuery, query, setQuery]);

  function updateFilter(key: 'status' | 'evaluation', value: string) {
    void setQuery({ [key]: value === 'all' ? null : value, page: null });
  }

  function applyQuickFilter(next: 'all' | 'needs_evaluation' | 'running') {
    if (next === 'all') {
      void setQuery({ status: null, evaluation: null, page: null });
      return;
    }
    if (next === 'needs_evaluation') {
      void setQuery({ status: null, evaluation: 'needs_evaluation', page: null });
      return;
    }
    void setQuery({ status: 'running', evaluation: null, page: null });
  }

  const quickFilter =
    evaluation === 'needs_evaluation' && status === 'all'
      ? 'needs_evaluation'
      : status === 'running' && evaluation === 'all'
        ? 'running'
        : status === 'all' && evaluation === 'all'
          ? 'all'
          : null;
  const advancedFiltersVisible =
    showFilters || (quickFilter === null && (status !== 'all' || evaluation !== 'all'));
  const columns = useMemo(
    () => createReviewColumns(t, common, detailScenario, returnQuery),
    [common, detailScenario, returnQuery, t],
  );
  const table = useTable({ features, data: response.items, columns });
  const filtered = query || status !== 'all' || evaluation !== 'all';

  if (error) {
    return (
      <Alert variant="destructive" className="rounded-2xl bg-surface p-5">
        <AlertCircleIcon aria-hidden="true" />
        <AlertTitle>{t('errorTitle')}</AlertTitle>
        <AlertDescription>{t('errorDescription')}</AlertDescription>
        <Button variant="outline" onClick={() => router.refresh()}>
          {common('retry')}
        </Button>
      </Alert>
    );
  }

  if (!response.items.length && !filtered) {
    return (
      <Empty className="rounded-2xl border border-dashed border-border bg-surface">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchIcon aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
          <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <div className="border-b border-border/70 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 className="text-xl font-bold tracking-[-0.025em]">{t('reviewQueue')}</h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('queueDescription')}</p>
          </div>
          <div
            role="group"
            className="inline-flex w-fit rounded-xl bg-surface-subtle p-1"
            aria-label={t('quickFilters')}
          >
            <QuickFilterButton
              pressed={quickFilter === 'all'}
              onClick={() => applyQuickFilter('all')}
            >
              {t('quickAll')}
            </QuickFilterButton>
            <QuickFilterButton
              pressed={quickFilter === 'needs_evaluation'}
              onClick={() => applyQuickFilter('needs_evaluation')}
            >
              {t('quickNeedsReview')}
            </QuickFilterButton>
            <QuickFilterButton
              pressed={quickFilter === 'running'}
              onClick={() => applyQuickFilter('running')}
            >
              {t('quickRunning')}
            </QuickFilterButton>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <div className="relative min-w-0 flex-1">
            <SearchIcon
              className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              className="h-11 rounded-xl border-transparent bg-surface-subtle pl-10 text-sm shadow-none focus-visible:border-ring"
              value={draftQuery}
              onChange={(event) => setDraftQuery(event.target.value)}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchLabel')}
            />
          </div>
          <button
            type="button"
            className="inline-flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-xl border border-border bg-background px-3.5 text-sm font-semibold text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            aria-expanded={advancedFiltersVisible}
            onClick={() => setShowFilters((visible) => !visible)}
          >
            <SlidersHorizontalIcon aria-hidden="true" className="size-4" />
            {t('filters')}
          </button>
        </div>

        {advancedFiltersVisible ? (
          <div className="mt-3 flex flex-wrap justify-end gap-2">
            <Select
              value={status}
              onValueChange={(value) => updateFilter('status', value ?? 'all')}
            >
              <SelectTrigger className="h-10 rounded-xl" aria-label={t('statusFilter')}>
                <SelectValue>{status === 'all' ? t('allStatuses') : t(status)}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allStatuses')}</SelectItem>
                <SelectItem value="running">{t('running')}</SelectItem>
                <SelectItem value="completed">{t('completed')}</SelectItem>
                <SelectItem value="failed">{t('failed')}</SelectItem>
                <SelectItem value="superseded">{t('superseded')}</SelectItem>
              </SelectContent>
            </Select>
            <Select
              value={evaluation}
              onValueChange={(value) => updateFilter('evaluation', value ?? 'all')}
            >
              <SelectTrigger className="h-10 rounded-xl" aria-label={t('evaluationFilter')}>
                <SelectValue>
                  {evaluation === 'all'
                    ? t('allEvaluations')
                    : evaluation === 'needs_evaluation'
                      ? t('notEvaluated')
                      : t('evaluated')}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t('allEvaluations')}</SelectItem>
                <SelectItem value="needs_evaluation">{t('notEvaluated')}</SelectItem>
                <SelectItem value="evaluated">{t('evaluated')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      <div className="hidden md:block">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((group) => (
              <TableRow key={group.id} className="hover:bg-transparent">
                {group.headers.map((header) => (
                  <TableHead
                    key={header.id}
                    className={`h-11 bg-background/45 px-5 text-sm font-semibold text-muted-foreground ${columnClass(header.column.id) ?? ''}`}
                  >
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow
                key={row.id}
                className="cursor-pointer border-border/70 hover:bg-surface-subtle/65"
                onClick={() =>
                  router.push(`/reviews/${row.original.id}${returnQuery ? `?${returnQuery}` : ''}`)
                }
              >
                {row.getAllCells().map((cell) => (
                  <TableCell
                    key={cell.id}
                    className={`px-5 py-4 align-middle ${columnClass(cell.column.id) ?? ''}`}
                  >
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="divide-y divide-border/70 md:hidden">
        {response.items.map((item) => (
          <MobileReviewRow
            key={item.id}
            item={item}
            detailScenario={detailScenario}
            returnQuery={returnQuery}
          />
        ))}
      </div>

      {!response.items.length ? (
        <p className="px-5 py-10 text-center text-sm text-muted-foreground">
          {t('filteredEmptyDescription')}
        </p>
      ) : null}

      <div className="px-4 py-4 sm:px-5">
        <ListPagination
          page={response.page}
          totalPages={response.total_pages}
          t={t}
          pathname={pathname}
          locale={locale}
          searchParams={searchParams}
        />
      </div>
    </section>
  );
}

function QuickFilterButton({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className="h-9 rounded-lg px-3.5 text-sm font-semibold text-muted-foreground transition-all hover:text-foreground aria-pressed:bg-surface aria-pressed:text-foreground aria-pressed:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {children}
    </button>
  );
}

function MobileReviewRow({
  item,
  detailScenario,
  returnQuery,
}: {
  item: ReviewListItem;
  detailScenario?: string | undefined;
  returnQuery?: string | undefined;
}) {
  const t = useTranslations('reviews');
  const href = `/reviews/${item.id}${returnQuery ? `?${returnQuery}` : detailScenario ? `?fixture=${detailScenario}` : ''}`;
  return (
    <div className="relative px-4 py-4">
      <Link href={href} className="block pr-9">
        <p className="text-sm font-semibold text-foreground">
          {item.pull_request_title ?? t('untitled')}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {item.repository} · PR #{item.pull_request_number}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <StatusSignal status={item.status} t={t} />
          {item.findings_count !== null ? (
            <span className="text-xs">
              <FindingSummary item={item} t={t} />
            </span>
          ) : null}
          <span className="text-xs text-muted-foreground">{formatDuration(item.duration_ms)}</span>
        </div>
        {item.status === 'completed' ? (
          <div className="mt-2 text-xs text-muted-foreground">
            <EvaluationSummary item={item} t={t} />
          </div>
        ) : null}
      </Link>
      <Button
        variant="ghost"
        size="icon-sm"
        nativeButton={false}
        className="absolute top-3.5 right-3 rounded-lg text-muted-foreground"
        aria-label={t('openGitHub')}
        render={
          <a
            href={`https://github.com/${item.repository}/pull/${item.pull_request_number}`}
            target="_blank"
            rel="noreferrer"
          />
        }
      >
        <ExternalLinkIcon aria-hidden="true" />
      </Button>
    </div>
  );
}

function ListPagination({
  page,
  totalPages,
  t,
  pathname,
  locale,
  searchParams,
}: {
  page: number;
  totalPages: number;
  t: (key: string) => string;
  pathname: string;
  locale: string;
  searchParams: { toString(): string };
}) {
  if (totalPages <= 1) {
    return null;
  }

  const hrefFor = (nextPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', String(nextPage));
    const localizedPath =
      pathname === `/${locale}` || pathname.startsWith(`/${locale}/`)
        ? pathname
        : `/${locale}${pathname.startsWith('/') ? pathname : `/${pathname}`}`;
    return `${localizedPath}?${params.toString()}`;
  };

  const candidates = new Set([1, totalPages, page - 1, page, page + 1]);
  const pages = [...candidates]
    .filter((value) => value > 0 && value <= totalPages)
    .sort((a, b) => a - b);
  const items: ReactNode[] = [];
  pages.forEach((value, index) => {
    if (index > 0 && value - pages[index - 1]! > 1) {
      items.push(<PaginationEllipsis key={`ellipsis-${value}`} label={t('paginationEllipsis')} />);
    }
    items.push(
      <PaginationItem key={value}>
        <PaginationLink href={hrefFor(value)} isActive={page === value}>
          {value}
        </PaginationLink>
      </PaginationItem>,
    );
  });
  return (
    <Pagination aria-label={t('pagination')}>
      <PaginationContent>
        <PaginationItem>
          {page > 1 ? <PaginationPrevious text={t('previous')} href={hrefFor(page - 1)} /> : null}
        </PaginationItem>
        {items}
        <PaginationItem>
          {page < totalPages ? <PaginationNext text={t('next')} href={hrefFor(page + 1)} /> : null}
        </PaginationItem>
      </PaginationContent>
    </Pagination>
  );
}
