import type {
  DevelopmentRepository,
  DevelopmentRunSummary,
  DevelopmentTicket,
} from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/table';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { DevelopmentCreateSheet } from './development-create-sheet';

export async function DevelopmentDashboard({
  runs,
  repositories,
  tickets,
}: {
  runs: DevelopmentRunSummary[] | null;
  repositories: DevelopmentRepository[] | null;
  tickets: DevelopmentTicket[] | null;
}) {
  const [t, locale] = await Promise.all([getTranslations('development'), getLocale()]);
  const attentionCount = runs?.filter((run) => run.operator_action !== null).length ?? 0;
  const orderedRuns = runs === null ? null : [...runs].sort(compareRuns);
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-4 border-b pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {repositories !== null && repositories.length > 0 ? (
          <DevelopmentCreateSheet repositories={repositories} tickets={tickets} />
        ) : null}
      </header>
      {repositories === null ? (
        <Alert variant="destructive">
          <AlertTitle>{t('repositoryCatalogUnavailable')}</AlertTitle>
          <AlertDescription>{t('repositoryCatalogUnavailableDescription')}</AlertDescription>
        </Alert>
      ) : repositories.length === 0 ? (
        <Alert>
          <AlertTitle>{t('repositoryCatalogEmpty')}</AlertTitle>
          <AlertDescription>{t('repositoryCatalogEmptyDescription')}</AlertDescription>
        </Alert>
      ) : null}
      <section aria-labelledby="development-runs-title" className="flex min-w-0 flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 id="development-runs-title" className="font-semibold">
              {t('runs')}
            </h2>
            <p className="text-sm text-muted-foreground">{t('runsDescription')}</p>
          </div>
          {attentionCount > 0 ? (
            <Badge>{t('attentionCount', { count: attentionCount })}</Badge>
          ) : null}
        </div>
        {orderedRuns === null ? (
          <Empty className="border-y">
            <EmptyHeader>
              <EmptyTitle>{t('unavailable')}</EmptyTitle>
              <EmptyDescription>{t('unavailableDescription')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : orderedRuns.length === 0 ? (
          <Empty className="border-y">
            <EmptyHeader>
              <EmptyTitle>{t('empty')}</EmptyTitle>
              <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="hidden overflow-hidden rounded-lg border md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columnWork')}</TableHead>
                    <TableHead>{t('columnRepository')}</TableHead>
                    <TableHead>{t('columnStatus')}</TableHead>
                    <TableHead className="text-right">{t('columnLastActivity')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {orderedRuns.map((run) => (
                    <TableRow key={run.id}>
                      <TableCell className="max-w-md">
                        <Link
                          href={`/development/${run.id}`}
                          className="block truncate font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {summarizeGoal(run.goal)}
                        </Link>
                        <span className="text-xs text-muted-foreground">#{run.id}</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{run.repository}</TableCell>
                      <TableCell>
                        <RunStatusBadge run={run} label={t(`phase_${run.phase}`)} />
                      </TableCell>
                      <TableCell className="text-right text-muted-foreground">
                        {dateTime.format(new Date(run.last_activity_at))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            <div className="divide-y rounded-lg border md:hidden">
              {orderedRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/development/${run.id}`}
                  className="flex flex-col gap-3 p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex items-start justify-between gap-3">
                    <span className="line-clamp-2 font-medium">{summarizeGoal(run.goal)}</span>
                    <RunStatusBadge run={run} label={t(`phase_${run.phase}`)} />
                  </span>
                  <span className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span className="font-mono">{run.repository}</span>
                    <span>{dateTime.format(new Date(run.last_activity_at))}</span>
                  </span>
                </Link>
              ))}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function RunStatusBadge({ run, label }: { run: DevelopmentRunSummary; label: string }) {
  return (
    <Badge
      variant={
        run.operator_action ? 'default' : run.phase === 'failed' ? 'destructive' : 'secondary'
      }
    >
      {label}
    </Badge>
  );
}

function summarizeGoal(goal: string): string {
  const summary = goal.split(/\r?\n/, 1)[0]?.replaceAll(/\s+/g, ' ').trim() ?? '';
  return summary.length > 120 ? `${summary.slice(0, 117)}…` : summary;
}

function compareRuns(left: DevelopmentRunSummary, right: DevelopmentRunSummary): number {
  const rank = (run: DevelopmentRunSummary) => {
    if (run.operator_action !== null) {
      return 0;
    }
    if (!['completed', 'failed', 'cancelled'].includes(run.phase)) {
      return 1;
    }

    return 2;
  };

  return rank(left) - rank(right) || right.last_activity_at.localeCompare(left.last_activity_at);
}
