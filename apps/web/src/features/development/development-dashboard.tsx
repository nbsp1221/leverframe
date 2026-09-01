import type {
  DevelopmentRepository,
  DevelopmentRunSummary,
  DevelopmentTicket,
} from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/card';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@repo/ui/components/empty';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { DevelopmentCreateForm } from './development-create-form';

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
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,3fr)_minmax(20rem,2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('newRun')}</CardTitle>
            <CardDescription>{t('newRunDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
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
            ) : (
              <DevelopmentCreateForm repositories={repositories} tickets={tickets} />
            )}
          </CardContent>
        </Card>
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
          <div className="divide-y border-y">
            {orderedRuns === null ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('unavailable')}</EmptyTitle>
                  <EmptyDescription>{t('unavailableDescription')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : orderedRuns.length === 0 ? (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{t('empty')}</EmptyTitle>
                  <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              orderedRuns.map((run) => (
                <Link
                  key={run.id}
                  href={`/development/${run.id}`}
                  className="flex items-start justify-between gap-3 px-1 py-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">
                      #{run.id} · {summarizeGoal(run.goal)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.repository} · {dateTime.format(new Date(run.last_activity_at))}
                    </span>
                  </span>
                  <Badge
                    variant={
                      run.operator_action
                        ? 'default'
                        : run.phase === 'failed'
                          ? 'destructive'
                          : 'secondary'
                    }
                  >
                    {t(`phase_${run.phase}`)}
                  </Badge>
                </Link>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
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
