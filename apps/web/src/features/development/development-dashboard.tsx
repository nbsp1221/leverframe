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
import { getTranslations } from 'next-intl/server';
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
  const t = await getTranslations('development');
  const attentionCount = runs?.filter((run) => run.operator_action !== null).length ?? 0;
  const activeCount =
    runs?.filter((run) => !['completed', 'failed', 'cancelled'].includes(run.phase)).length ?? 0;
  const orderedRuns = runs === null ? null : [...runs].sort(compareRuns);
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-medium text-muted-foreground">development-v1</p>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{t('title')}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <SummaryCard label={t('activeRuns')} value={activeCount} />
        <SummaryCard label={t('needsAttention')} value={attentionCount} />
        <SummaryCard label={t('availableRepositories')} value={repositories?.length ?? 0} />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('runs')}</CardTitle>
            <CardDescription>{t('runsDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
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
                  className="flex items-start justify-between gap-4 rounded-lg border p-4 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-medium">
                      #{run.id} · {run.goal}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {run.repository} · {new Date(run.last_activity_at).toLocaleString()}
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
          </CardContent>
        </Card>
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
      </div>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between py-4">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="text-2xl font-semibold tabular-nums">{value}</span>
      </CardContent>
    </Card>
  );
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
