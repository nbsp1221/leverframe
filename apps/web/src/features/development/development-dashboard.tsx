import type {
  DevelopmentRepository,
  DevelopmentRunSummary,
  DevelopmentTicket,
} from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Button } from '@repo/ui/components/button';
import { getTranslations } from 'next-intl/server';
import { PageFrame } from '../../components/page-frame';
import { PageMetric } from '../../components/page-metric';
import { PageSurface } from '../../components/page-surface';
import { Link } from '../../i18n/navigation';
import { DevelopmentCreateSheet } from './development-create-sheet';
import { DevelopmentRunList } from './development-run-list';

const terminalPhases = new Set(['completed', 'failed', 'cancelled']);

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
  const orderedRuns = runs === null ? null : [...runs].sort(compareRuns);
  const attentionCount = runs?.filter((run) => run.operator_action !== null).length ?? null;
  const activeCount = runs?.filter((run) => !terminalPhases.has(run.phase)).length ?? null;
  const finishedCount = runs?.filter((run) => terminalPhases.has(run.phase)).length ?? null;
  const nextAction = orderedRuns?.find((run) => run.operator_action !== null);

  return (
    <PageFrame className="flex flex-col gap-6 lg:gap-7">
      <header className="flex flex-col gap-4 px-0.5 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-[-0.045em]">{t('title')}</h1>
          <p className="mt-1.5 text-sm text-muted-foreground">{t('subtitle')}</p>
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

      <PageSurface>
        <div className="grid sm:grid-cols-3 xl:grid-cols-[minmax(28rem,1.75fr)_repeat(3,minmax(10rem,0.62fr))]">
          <div className="flex min-h-36 flex-col justify-center border-b border-border/75 px-6 py-6 sm:col-span-3 sm:px-7 xl:col-span-1 xl:border-r xl:border-b-0 xl:px-8">
            <p className="text-sm font-semibold text-muted-foreground">{t('mostImportant')}</p>
            <h2 className="mt-2 max-w-3xl text-2xl font-bold tracking-[-0.04em] sm:text-3xl">
              {attentionCount === null
                ? t('attentionUnavailable')
                : attentionCount > 0
                  ? t('attentionHeadline', { count: attentionCount })
                  : t('attentionClear')}
            </h2>
            {nextAction ? (
              <div className="mt-4">
                <Button
                  nativeButton={false}
                  render={<Link href={`/development/${nextAction.id}`} />}
                >
                  {t('openNextDecision')}
                </Button>
              </div>
            ) : null}
          </div>
          <PageMetric label={t('activeRuns')} value={activeCount ?? '—'} />
          <PageMetric label={t('finishedRuns')} value={finishedCount ?? '—'} />
          <PageMetric label={t('availableRepositories')} value={repositories?.length ?? '—'} last />
        </div>
      </PageSurface>

      <DevelopmentRunList runs={orderedRuns} />
    </PageFrame>
  );
}

function compareRuns(left: DevelopmentRunSummary, right: DevelopmentRunSummary): number {
  const rank = (run: DevelopmentRunSummary) => {
    if (run.operator_action !== null) {
      return 0;
    }
    return terminalPhases.has(run.phase) ? 2 : 1;
  };

  return rank(left) - rank(right) || right.last_activity_at.localeCompare(left.last_activity_at);
}
