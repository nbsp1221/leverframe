import type { EvaluationsResponse, ReviewDetail } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { ArrowLeftIcon, ChevronDownIcon, ExternalLinkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { CopyShaButton } from './copy-sha';
import { FindingContext } from './finding-context';
import { ReviewEvaluationPanel } from './review-evaluation';
import { ReviewExecutionTrace } from './review-execution-trace';
import { RelativeTime } from './review-list-columns';
import { ReviewLiveActivity } from './review-live-activity';
import { ReviewPageFrame } from './review-page-frame';

type Finding = ReviewDetail['artifact']['findings'][number];
type Translator = (key: string, values?: Record<string, string | number>) => string;

export async function ReviewDetailPage({
  detail,
  returnQuery = '',
  evaluations = null,
}: {
  detail: ReviewDetail;
  returnQuery?: string | undefined;
  evaluations?: EvaluationsResponse | null;
}) {
  const t = await getTranslations('reviewDetail');
  const githubUrl = `https://github.com/${detail.repository}/pull/${detail.pull_request_number}`;
  const completed = detail.status === 'completed';

  return (
    <ReviewPageFrame className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/reviews${returnQuery ? `?${returnQuery}` : ''}`}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          {t('backToList')}
        </Link>
        <Button
          variant="outline"
          nativeButton={false}
          render={<a href={githubUrl} target="_blank" rel="noreferrer" />}
        >
          <ExternalLinkIcon aria-hidden="true" />
          {t('openGitHub')}
        </Button>
      </div>

      <header className="flex flex-col gap-2 border-b border-border pb-5">
        <p className="text-sm text-muted-foreground">
          {detail.repository} · {t('pullRequest')} #{detail.pull_request_number}
        </p>
        <h1 className="max-w-5xl break-words text-2xl font-bold tracking-[-0.04em] sm:text-3xl">
          {detail.pull_request_title ?? t('untitled')}
        </h1>
        <p className="text-sm text-muted-foreground">{t('detailIntro')}</p>
      </header>

      <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
        <main className="min-w-0 space-y-5">
          <StatusOverview detail={detail} t={t} returnQuery={returnQuery} />

          {detail.status === 'running' ? (
            <PrimarySurface>
              <ReviewLiveActivity reviewId={detail.id} mode="live" />
            </PrimarySurface>
          ) : null}

          {['failed', 'superseded', 'cancelled'].includes(detail.status) ? (
            <PrimarySurface>
              <ReviewLiveActivity reviewId={detail.id} mode="recent" />
            </PrimarySurface>
          ) : null}

          {completed ? (
            detail.artifact.available ? (
              <>
                {detail.artifact.findings.length ? (
                  <FindingsSurface detail={detail} evaluations={evaluations} t={t} />
                ) : null}
                <VerificationSurface detail={detail} t={t} />
              </>
            ) : (
              <Alert>
                <AlertTitle>{t('artifactUnavailable')}</AlertTitle>
                <AlertDescription>
                  {detail.artifact.unavailable_reason ?? t('artifactUnavailableDescription')}
                </AlertDescription>
              </Alert>
            )
          ) : null}

          <TechnicalDetails detail={detail} t={t} />
        </main>

        <aside
          className="min-w-0 space-y-5 xl:sticky xl:top-20 xl:self-start"
          aria-label={completed ? t('evaluation') : t('runInfoTitle')}
        >
          {completed ? (
            <section className="rounded-2xl border border-border/75 bg-surface p-5 shadow-sm shadow-foreground/[0.025]">
              <h2 className="text-lg font-bold tracking-[-0.025em]">{t('reviewHelpfulTitle')}</h2>
              <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
                {t('reviewHelpfulDescription')}
              </p>
              <ReviewEvaluationPanel
                reviewId={detail.id}
                target="review"
                current={evaluations ? evaluations.review.current : detail.review_evaluation}
                history={
                  evaluations?.review.history ??
                  (detail.review_evaluation ? [detail.review_evaluation] : [])
                }
                disabled={!detail.artifact.available || evaluations === null}
                disabledReason={!detail.artifact.available ? 'artifact' : 'evaluations'}
                presentation="rail"
              />
            </section>
          ) : null}
          <RunInfo detail={detail} t={t} />
        </aside>
      </div>
    </ReviewPageFrame>
  );
}

function StatusOverview({
  detail,
  t,
  returnQuery,
}: {
  detail: ReviewDetail;
  t: Translator;
  returnQuery: string;
}) {
  if (detail.status === 'completed') {
    const coverage = detail.artifact.coverage;
    const findingCount = detail.artifact.available ? detail.artifact.findings.length : 0;
    return (
      <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
        <div className="px-6 py-6 sm:px-7">
          <p className="text-sm font-semibold text-muted-foreground">{t('overviewEyebrow')}</p>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.045em] text-success sm:text-3xl">
            {detail.artifact.available
              ? findingCount > 0
                ? t('overviewFindingsHeadline', { count: findingCount })
                : t('overviewNoFindingsHeadline')
              : t('artifactUnavailable')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {detail.artifact.available
              ? findingCount > 0
                ? t('overviewFindingsDescription')
                : t('overviewNoFindingsDescription')
              : t('artifactUnavailableDescription')}
          </p>
          {detail.artifact.available ? (
            <div className="mt-5 max-w-5xl border-t border-border/70 pt-4">
              <p className="text-xs font-semibold text-muted-foreground">{t('summary')}</p>
              <p className="mt-1.5 whitespace-pre-wrap break-words text-sm leading-6">
                {detail.artifact.summary ?? t('summaryEmpty')}
              </p>
            </div>
          ) : null}
        </div>
        <div className="grid border-t border-border/70 sm:grid-cols-3 sm:divide-x sm:divide-border/70">
          <Metric
            label={t('metricFindings')}
            value={detail.artifact.available ? t('countItems', { count: findingCount }) : '—'}
          />
          <Metric
            label={t('metricFiles')}
            value={
              coverage
                ? `${coverage.reviewed_files.length} / ${coverage.changed_files.length}`
                : '—'
            }
          />
          <Metric label={t('metricDuration')} value={formatDuration(detail, t)} />
        </div>
      </section>
    );
  }

  const copy = statusCopy(detail, t);
  return (
    <section className="rounded-2xl border border-border/75 bg-surface px-6 py-6 shadow-sm shadow-foreground/[0.025] sm:px-7">
      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="min-w-0 max-w-4xl">
          <p className={`inline-flex items-center gap-2 text-sm font-semibold ${copy.tone}`}>
            <span className="size-2 rounded-full bg-current" aria-hidden="true" />
            {copy.eyebrow}
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-[-0.04em] sm:text-3xl">
            {copy.headline}
          </h2>
          <p className="mt-2 text-sm leading-6 text-muted-foreground">{copy.description}</p>
          {detail.error_excerpt ? (
            <p className="mt-4 border-t border-border/70 pt-4 text-sm text-danger">
              {detail.error_excerpt}
            </p>
          ) : null}
          {detail.status === 'superseded' && detail.superseded_by_job_id ? (
            <Button
              nativeButton={false}
              size="sm"
              className="mt-4"
              render={
                <Link
                  href={`/reviews/${detail.superseded_by_job_id}${returnQuery ? `?${returnQuery}` : ''}`}
                />
              }
            >
              {t('viewNewRun')}
            </Button>
          ) : null}
        </div>
        <div className="text-right text-xs text-muted-foreground">
          {detail.review_started_at ? (
            <p>
              {t('started')} · <RelativeTime value={detail.review_started_at} />
            </p>
          ) : (
            <p>{t(detail.status)}</p>
          )}
        </div>
      </div>
    </section>
  );
}

function FindingsSurface({
  detail,
  evaluations,
  t,
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
  t: Translator;
}) {
  const findings = sortFindings(detail.artifact.findings);
  return (
    <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <SectionHeader
        title={t('findingsFriendlyTitle')}
        description={t('findingsFriendlyDescription')}
      />
      <div className="px-6 pb-1 sm:px-7">
        {findings.length ? (
          findings.map((finding, index) => (
            <FindingRow
              key={finding.fingerprint}
              index={index + 1}
              finding={finding}
              detail={detail}
              evaluations={evaluations}
              t={t}
            />
          ))
        ) : (
          <p className="border-t border-border/70 py-6 text-sm text-muted-foreground">
            {t('noActionableDefects')}
          </p>
        )}
      </div>
    </section>
  );
}

function FindingRow({
  index,
  finding,
  detail,
  evaluations,
  t,
}: {
  index: number;
  finding: Finding;
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
  t: Translator;
}) {
  return (
    <article className="border-t border-border/70 py-6 first:border-t-0 first:pt-1">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] items-start gap-x-3">
        <span className="grid size-7 place-items-center rounded-lg bg-muted text-xs font-bold text-muted-foreground">
          {index}
        </span>
        <div className="min-w-0 pt-0.5">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <h3 className="max-w-4xl break-words font-semibold leading-6">{finding.title}</h3>
            <div className="shrink-0 pt-0.5">
              <SeverityPill severity={finding.severity} t={t} />
            </div>
          </div>
          <p className="mt-1.5 max-w-4xl whitespace-pre-wrap break-words text-sm leading-6 text-muted-foreground">
            {finding.explanation}
          </p>
        </div>
      </div>
      <div className="mt-3 ml-10 flex flex-wrap items-start gap-x-2 gap-y-2">
        <EvidenceDisclosure finding={finding} detail={detail} t={t} />
        <ReviewEvaluationPanel
          reviewId={detail.id}
          target="finding"
          fingerprint={finding.fingerprint}
          current={evaluations?.findings[finding.fingerprint]?.current ?? null}
          fallbackVerdict={evaluations === null ? finding.evaluation : null}
          history={evaluations?.findings[finding.fingerprint]?.history ?? []}
          disabled={evaluations === null}
          disabledReason="evaluations"
          presentation="inline"
        />
      </div>
      {finding.state && finding.state !== 'open' ? (
        <p className="mt-2 ml-10 text-xs text-muted-foreground">{t(finding.state)}</p>
      ) : null}
    </article>
  );
}

function EvidenceDisclosure({
  finding,
  detail,
  t,
}: {
  finding: Finding;
  detail: ReviewDetail;
  t: Translator;
}) {
  return (
    <Collapsible className="contents">
      <CollapsibleTrigger className="order-1 inline-flex h-8 items-center gap-1.5 rounded-lg px-2 text-sm font-semibold text-link transition-colors hover:bg-muted hover:text-link">
        {t('evidenceShort')}
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="order-2 mt-1 w-full basis-full">
        <div className="max-w-5xl rounded-xl border border-border/70 bg-surface-subtle p-4 text-sm leading-6 sm:p-5">
          <p className="max-w-4xl whitespace-pre-wrap break-words">{finding.evidence}</p>
          <div className="mt-4 max-w-4xl border-t border-border/70 pt-4">
            <p className="text-xs font-semibold text-muted-foreground">{t('suggestedAction')}</p>
            <p className="mt-1.5 whitespace-pre-wrap break-words">{finding.suggested_action}</p>
          </div>
          <div className="mt-4 border-t border-border/70 pt-4">
            <FindingContext reviewId={detail.id} fingerprint={finding.fingerprint} embedded />
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-4">
            <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
              <code className="break-all">
                {finding.file}:{finding.line}
              </code>
              <span className="break-all">
                {t('fingerprint')}: {finding.fingerprint}
              </span>
            </div>
            <Button
              variant="outline"
              size="sm"
              nativeButton={false}
              render={
                <a
                  href={githubLocationUrl(detail, finding.file, finding.line)}
                  target="_blank"
                  rel="noreferrer"
                />
              }
            >
              <ExternalLinkIcon aria-hidden="true" />
              {t('openCodeLocation')}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

function VerificationSurface({ detail, t }: { detail: ReviewDetail; t: Translator }) {
  const coverage = detail.artifact.coverage;
  const changed = coverage?.changed_files.length ?? 0;
  const reviewed = coverage?.reviewed_files.length ?? 0;
  const omitted = coverage?.omitted_files.length ?? 0;
  const percentage =
    changed === 0 ? (coverage?.complete ? 100 : 0) : Math.round((reviewed / changed) * 100);

  return (
    <section className="rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <SectionHeader
        title={t('verificationTitle')}
        description={
          coverage?.complete
            ? t('verificationCompleteDescription')
            : t('verificationIncompleteDescription')
        }
      />
      <div className="px-6 pb-6 sm:px-7">
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-success"
            style={{ width: `${Math.min(100, percentage)}%` }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
          <span>{t('filesReviewedCount', { reviewed, total: changed })}</span>
          <span>{t('omittedCount', { count: omitted })}</span>
        </div>
        <div className="mt-5 grid gap-4 border-t border-border/70 pt-5 sm:grid-cols-3">
          <CompactFact label={t('verificationTests')} value={testSummary(detail, t)} />
          <CompactFact
            label={t('verificationOmitted')}
            value={t('countItems', { count: omitted })}
          />
          <CompactFact
            label={t('verificationPublished')}
            value={detail.published_at ? t('completed') : t('notPublished')}
          />
        </div>
        <VerificationDetails detail={detail} t={t} />
      </div>
    </section>
  );
}

function VerificationDetails({ detail, t }: { detail: ReviewDetail; t: Translator }) {
  const coverage = detail.artifact.coverage;
  const hasDetails = Boolean(
    coverage || detail.artifact.tests_run.length || detail.artifact.limitations.length,
  );
  if (!hasDetails) {
    return null;
  }
  return (
    <Collapsible className="mt-5 border-t border-border/70 pt-4">
      <CollapsibleTrigger className="flex w-full items-center justify-between text-left text-sm font-semibold text-muted-foreground hover:text-foreground">
        {t('verificationDetails')}
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4 space-y-5 text-sm">
        {coverage ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <FileList title={t('changedFiles')} values={coverage.changed_files} />
            <FileList title={t('reviewedFiles')} values={coverage.reviewed_files} />
            <FileList title={t('omittedFiles')} values={coverage.omitted_files} />
          </div>
        ) : null}
        {detail.artifact.tests_run.length ? (
          <div>
            <p className="font-semibold">{t('testsRun')}</p>
            <div className="mt-2 divide-y divide-border/70 border-y border-border/70">
              {detail.artifact.tests_run.map((test) => (
                <Collapsible key={test.command}>
                  <CollapsibleTrigger className="flex w-full min-w-0 items-center justify-between gap-3 py-3 text-left">
                    <span className="min-w-0 truncate">
                      <code>{test.command}</code> · {t(test.status)}
                    </span>
                    <ChevronDownIcon className="size-4 shrink-0" aria-hidden="true" />
                  </CollapsibleTrigger>
                  <CollapsibleContent className="pb-3">
                    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted p-3 text-xs">
                      {test.evidence}
                    </pre>
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          </div>
        ) : null}
        {detail.artifact.limitations.length ? (
          <div>
            <p className="font-semibold">{t('limitations')}</p>
            <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
              {detail.artifact.limitations.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

function TechnicalDetails({ detail, t }: { detail: ReviewDetail; t: Translator }) {
  const primary = [
    [t('model'), detail.model ?? '—'],
    [t('reasoning'), detail.reasoning ?? '—'],
    [t('promptVersion'), detail.prompt_version ?? '—'],
    [t('schemaVersion'), detail.schema_version ?? '—'],
    [t('attempt'), detail.attempt === null ? '—' : `#${detail.attempt}`],
    [t('runId'), `#${detail.id}`],
  ] as const;
  const provenance = [
    [t('baseSha'), detail.base_sha ?? '—'],
    [t('headSha'), detail.head_sha],
    [t('promptHash'), detail.prompt_hash ?? '—'],
    [t('schemaHash'), detail.schema_hash ?? '—'],
  ] as const;

  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg py-3 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
        {t('technicalDetailsTitle')}
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1">
        <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
          <div className="p-5 sm:p-6">
            <h3 className="text-base font-bold tracking-[-0.02em]">{t('diagnostics')}</h3>
            <p className="mt-1 max-w-3xl text-sm leading-5 text-muted-foreground">
              {t('diagnosticsDescription')}
            </p>
            <div className="mt-5 grid min-w-0 gap-x-8 gap-y-4 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {primary.map(([label, value]) => (
                <TechnicalFact key={label} label={label} value={value} />
              ))}
            </div>

            <Collapsible className="mt-5 border-t border-border/70 pt-4">
              <CollapsibleTrigger className="flex w-full items-center justify-between text-left text-sm font-semibold text-muted-foreground transition-colors hover:text-foreground">
                {t('provenance')}
                <ChevronDownIcon className="size-4" aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <div className="grid min-w-0 gap-x-8 gap-y-4 text-sm sm:grid-cols-2">
                  {provenance.map(([label, value]) => (
                    <TechnicalFact
                      key={label}
                      label={label}
                      value={value}
                      copyValue={
                        (label === t('baseSha') || label === t('headSha')) &&
                        typeof value === 'string'
                          ? value
                          : undefined
                      }
                      copyLabel={`${t('copy')} ${label}`}
                    />
                  ))}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </div>
          <ReviewExecutionTrace reviewId={detail.id} />
        </section>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunInfo({ detail, t }: { detail: ReviewDetail; t: Translator }) {
  return (
    <section className="rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-bold">{t('runInfoTitle')}</h2>
      </div>
      <dl className="px-5 pb-4 text-sm">
        <InfoRow label={t('status')} value={t(detail.status)} />
        <InfoRow label={t('duration')} value={formatDuration(detail, t)} />
        <InfoRow label={t('model')} value={detail.model ?? '—'} />
        <InfoRow
          label={t('attempt')}
          value={detail.attempt === null ? '—' : `#${detail.attempt}`}
        />
        <InfoRow
          label={t('publication')}
          value={detail.published_at ? t('completed') : t('notPublished')}
        />
        {detail.error_code ? <InfoRow label={t('errorCode')} value={detail.error_code} /> : null}
        {detail.superseded_by_job_id ? (
          <InfoRow label={t('supersededBy')} value={`#${detail.superseded_by_job_id}`} />
        ) : null}
      </dl>
    </section>
  );
}

function statusCopy(detail: ReviewDetail, t: Translator) {
  if (detail.status === 'running') {
    return {
      eyebrow: t('runningEyebrow'),
      headline: t('runningHeadline'),
      description: t('runningLivenessDescription'),
      tone: 'text-info',
    };
  }
  if (detail.status === 'failed') {
    return {
      eyebrow: t('failedEyebrow'),
      headline: t('failedHeadline'),
      description: t('failedFriendlyDescription'),
      tone: 'text-danger',
    };
  }
  if (detail.status === 'queued') {
    return {
      eyebrow: t('queuedEyebrow'),
      headline: t('queuedHeadline'),
      description: t('queuedFriendlyDescription'),
      tone: 'text-info',
    };
  }
  if (detail.status === 'cancelled') {
    return {
      eyebrow: t('cancelledEyebrow'),
      headline: t('cancelledHeadline'),
      description: t('cancelledFriendlyDescription'),
      tone: 'text-muted-foreground',
    };
  }
  if (detail.status === 'superseded') {
    return {
      eyebrow: t('supersededEyebrow'),
      headline: t('supersededHeadline'),
      description: t('supersededFriendlyDescription'),
      tone: 'text-warning',
    };
  }
  return {
    eyebrow: t('unknown'),
    headline: t('unknownHeadline'),
    description: t('unknownFriendlyDescription'),
    tone: 'text-muted-foreground',
  };
}

function SeverityPill({ severity, t }: { severity: Finding['severity']; t: Translator }) {
  const tone =
    severity === 'critical' || severity === 'high'
      ? 'bg-danger-soft text-danger'
      : severity === 'medium'
        ? 'bg-warning-soft text-warning'
        : 'bg-muted text-muted-foreground';
  return (
    <Badge className={`${tone} border-0 shadow-none`}>
      {severity === 'critical' || severity === 'high'
        ? t('severityImportant')
        : severity === 'medium'
          ? t('severityNormal')
          : t('severityLow')}
    </Badge>
  );
}

function SectionHeader({ title, description }: { title: string; description: string }) {
  return (
    <div className="px-6 pt-5 pb-4 sm:px-7">
      <h2 className="text-xl font-bold tracking-[-0.025em]">{title}</h2>
      <p className="mt-1 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function PrimarySurface({ children }: { children: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-border/75 bg-surface px-6 py-6 shadow-sm shadow-foreground/[0.025] sm:px-7">
      {children}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-6 py-5 sm:px-7">
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-2 text-lg font-bold tabular-nums">{value}</p>
    </div>
  );
}

function CompactFact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold">{value}</p>
    </div>
  );
}

function TechnicalFact({
  label,
  value,
  copyValue,
  copyLabel,
}: {
  label: string;
  value: string;
  copyValue?: string | undefined;
  copyLabel?: string | undefined;
}) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="mt-1 flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 break-all font-medium">{value}</span>
        {copyValue && copyLabel ? <CopyShaButton value={copyValue} label={copyLabel} /> : null}
      </div>
    </div>
  );
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 border-t border-border/70 py-3 first:border-t-0 first:pt-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right font-medium">{value}</dd>
    </div>
  );
}

function FileList({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="min-w-0">
      <p className="font-semibold">
        {title} ({values.length})
      </p>
      <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
        {values.length ? (
          values.map((value) => (
            <li key={value} className="break-all font-mono">
              {value}
            </li>
          ))
        ) : (
          <li>—</li>
        )}
      </ul>
    </div>
  );
}

function sortFindings(findings: Finding[]): Finding[] {
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...findings].sort((left, right) => order[left.severity] - order[right.severity]);
}

function testSummary(detail: ReviewDetail, t: Translator): string {
  const tests = detail.artifact.tests_run;
  if (!tests.length) {
    return t('not_run');
  }
  const passed = tests.filter((test) => test.status === 'passed').length;
  return t('testsPassedCount', { passed, total: tests.length });
}

function formatDuration(detail: ReviewDetail, t: Translator): string {
  if (!detail.review_started_at) {
    return '—';
  }
  if (detail.status !== 'running' && !detail.review_completed_at) {
    return '—';
  }
  const end = detail.review_completed_at ? Date.parse(detail.review_completed_at) : Date.now();
  const seconds = Math.max(0, Math.round((end - Date.parse(detail.review_started_at)) / 1000));
  if (seconds < 60) {
    return t('durationSeconds', { count: seconds });
  }
  return t('durationMinutesSeconds', {
    minutes: Math.floor(seconds / 60),
    seconds: seconds % 60,
  });
}

function githubLocationUrl(detail: ReviewDetail, file: string, line: number): string {
  const repository = detail.repository.split('/').map(encodeURIComponent).join('/');
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repository}/blob/${encodeURIComponent(detail.head_sha)}/${path}#L${line}`;
}
