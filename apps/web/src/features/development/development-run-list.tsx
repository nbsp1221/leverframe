'use client';

import type { DevelopmentRunSummary } from '@repo/contracts';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty';
import { Input } from '@repo/ui/components/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/table';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import { SearchIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { parseAsString, parseAsStringLiteral, useQueryStates } from 'nuqs';
import { PageSurface } from '../../components/page-surface';
import { StatusSignal } from '../../components/status-signal';
import { Link } from '../../i18n/navigation';

type RunFilter = 'all' | 'attention' | 'active';

const terminalPhases = new Set(['completed', 'failed', 'cancelled']);

export function DevelopmentRunList({ runs }: { runs: DevelopmentRunSummary[] | null }) {
  const t = useTranslations('development');
  const locale = useLocale();
  const [{ view: filter, query }, setFilters] = useQueryStates(
    {
      view: parseAsStringLiteral<RunFilter>(['all', 'attention', 'active']).withDefault('all'),
      query: parseAsString.withDefault(''),
    },
    { shallow: true, history: 'replace' },
  );
  const returnQuery = new URLSearchParams({
    ...(filter === 'all' ? {} : { view: filter }),
    ...(query ? { query } : {}),
  }).toString();
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const normalizedQuery = query.trim().toLocaleLowerCase(locale);
  const visibleRuns = runs?.filter((run) => {
    const matchesFilter =
      filter === 'all' ||
      (filter === 'attention' && run.operator_action !== null) ||
      (filter === 'active' && !terminalPhases.has(run.phase));
    const matchesQuery =
      !normalizedQuery ||
      `${run.goal} ${run.repository} ${run.id}`.toLocaleLowerCase(locale).includes(normalizedQuery);
    return matchesFilter && matchesQuery;
  });

  return (
    <PageSurface aria-labelledby="development-runs-title">
      <div className="border-b border-border/70 px-5 pt-5 pb-4 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <h2 id="development-runs-title" className="text-xl font-bold tracking-[-0.025em]">
              {t('runs')}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">{t('runsDescription')}</p>
          </div>
          <ToggleGroup
            aria-label={t('runFilters')}
            value={[filter]}
            onValueChange={(value) => {
              const next = value[0];
              if (next === 'all' || next === 'attention' || next === 'active') {
                void setFilters({ view: next === 'all' ? null : next });
              }
            }}
            variant="default"
            size="sm"
            spacing={0}
            className="w-fit rounded-xl bg-surface-subtle p-1"
          >
            <ToggleGroupItem
              value="all"
              className="rounded-lg border-0 px-3.5 text-sm font-semibold shadow-none data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              {t('filterAll')}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="attention"
              className="rounded-lg border-0 px-3.5 text-sm font-semibold shadow-none data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              {t('filterAttention')}
            </ToggleGroupItem>
            <ToggleGroupItem
              value="active"
              className="rounded-lg border-0 px-3.5 text-sm font-semibold shadow-none data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              {t('filterActive')}
            </ToggleGroupItem>
          </ToggleGroup>
        </div>
        <div className="relative mt-4">
          <SearchIcon
            className="absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            className="h-11 rounded-xl border-transparent bg-surface-subtle pl-10 text-sm shadow-none focus-visible:border-ring"
            value={query}
            onChange={(event) => void setFilters({ query: event.target.value || null })}
            placeholder={t('searchRuns')}
            aria-label={t('searchRuns')}
          />
        </div>
      </div>

      {runs === null || runs.length === 0 || visibleRuns?.length === 0 ? (
        <Empty className="min-h-52 border-0">
          <EmptyHeader>
            <EmptyTitle>
              {runs === null
                ? t('unavailable')
                : runs.length === 0
                  ? t('empty')
                  : t('noMatchingRuns')}
            </EmptyTitle>
            <EmptyDescription>
              {runs === null
                ? t('unavailableDescription')
                : runs.length === 0
                  ? t('emptyDescription')
                  : t('noMatchingRunsDescription')}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow className="border-border/70 bg-background/60">
                  <TableHead className="w-[44%] pl-5 sm:pl-6">{t('columnWork')}</TableHead>
                  <TableHead>{t('columnStatus')}</TableHead>
                  <TableHead>{t('columnRepository')}</TableHead>
                  <TableHead className="pr-5 text-right sm:pr-6">
                    {t('columnLastActivity')}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visibleRuns?.map((run) => (
                  <TableRow key={run.id} className="border-border/70">
                    <TableCell className="max-w-0 py-4 pl-5 sm:pl-6">
                      <RunIdentity run={run} returnQuery={returnQuery} />
                    </TableCell>
                    <TableCell>
                      <RunSignal run={run} />
                    </TableCell>
                    <TableCell className="max-w-48 truncate text-sm text-muted-foreground">
                      {run.repository}
                    </TableCell>
                    <TableCell className="pr-5 text-right text-sm text-muted-foreground sm:pr-6">
                      {dateTime.format(new Date(run.last_activity_at))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <div className="divide-y divide-border/70 md:hidden">
            {visibleRuns?.map((run) => (
              <Link
                key={run.id}
                href={`/development/${run.id}${returnQuery ? `?${returnQuery}` : ''}`}
                className="flex flex-col gap-2.5 p-5 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="line-clamp-2 text-base font-semibold tracking-[-0.015em]">
                  {summarizeGoal(run.goal)}
                </span>
                <span className="flex items-center justify-between gap-3">
                  <RunSignal run={run} />
                  <span className="text-xs text-muted-foreground">#{run.id}</span>
                </span>
                <span className="flex min-w-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                  <span className="truncate">{run.repository}</span>
                  <span className="shrink-0">
                    {dateTime.format(new Date(run.last_activity_at))}
                  </span>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
    </PageSurface>
  );
}

function RunIdentity({ run, returnQuery }: { run: DevelopmentRunSummary; returnQuery: string }) {
  return (
    <Link
      href={`/development/${run.id}${returnQuery ? `?${returnQuery}` : ''}`}
      className="group block min-w-0 py-0.5"
    >
      <p className="truncate text-base font-semibold tracking-[-0.015em] text-foreground transition-colors group-hover:text-link">
        {summarizeGoal(run.goal)}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">#{run.id}</p>
    </Link>
  );
}

function RunSignal({ run }: { run: DevelopmentRunSummary }) {
  const t = useTranslations('development');
  const tone =
    run.operator_action !== null
      ? 'warning'
      : run.phase === 'completed'
        ? 'success'
        : run.phase === 'failed'
          ? 'danger'
          : run.phase === 'cancelled'
            ? 'muted'
            : 'info';
  return <StatusSignal tone={tone}>{t(`phase_${run.phase}`)}</StatusSignal>;
}

function summarizeGoal(goal: string): string {
  const summary = goal.split(/\r?\n/, 1)[0]?.replaceAll(/\s+/g, ' ').trim() ?? '';
  return summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
}
