import type { EvaluationsResponse, ReviewDetail } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Separator } from '@repo/ui/components/separator';
import { ArrowLeftIcon, ChevronDownIcon, ExternalLinkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { CopyShaButton } from './copy-sha';
import { FindingContext } from './finding-context';
import { ReviewEvaluationPanel } from './review-evaluation';
import { ReviewExecutionTrace } from './review-execution-trace';
import { RelativeTime } from './review-list-columns';

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
  const artifact = detail.artifact;
  const githubUrl = `https://github.com/${detail.repository}/pull/${detail.pull_request_number}`;
  const statusVariant =
    detail.status === 'failed'
      ? 'destructive'
      : detail.status === 'completed'
        ? 'secondary'
        : 'outline';
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6">
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
      <header className="flex flex-col gap-3 border-b border-border pb-5">
        <p className="text-sm text-muted-foreground">
          {detail.repository} · {t('pullRequest')} #{detail.pull_request_number}
        </p>
        <h1 className="max-w-4xl break-words text-2xl font-semibold tracking-tight sm:text-3xl">
          {detail.pull_request_title ?? t('untitled')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={statusVariant}>{t(detail.status)}</Badge>
          <Badge variant="outline">
            {t('runId')}: #{detail.id}
          </Badge>
          {detail.model ? <Badge variant="outline">{detail.model}</Badge> : null}
          {detail.reasoning ? <Badge variant="outline">{detail.reasoning}</Badge> : null}
        </div>
      </header>
      {detail.status !== 'completed' ? <StatusNotice detail={detail} t={t} /> : null}
      <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <ExecutionMetadata detail={detail} t={t} />
          <ReviewExecutionTrace reviewId={detail.id} />
          <Card>
            <CardHeader>
              <CardTitle>{t('summary')}</CardTitle>
              <CardDescription>{t('summaryDescription')}</CardDescription>
            </CardHeader>
            <CardContent>
              {!artifact.available ? (
                <UnavailableState detail={detail} t={t} />
              ) : artifact.summary ? (
                <p className="whitespace-pre-wrap break-words text-sm leading-7">
                  {artifact.summary}
                </p>
              ) : (
                <p className="rounded-md border border-dashed p-5 text-sm text-muted-foreground">
                  {t('summaryEmpty')}
                </p>
              )}
            </CardContent>
          </Card>
          <Findings detail={detail} t={t} evaluations={evaluations} />
          <Coverage detail={detail} t={t} />
        </div>
        <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>{t('evaluation')}</CardTitle>
              <CardDescription>{t('evaluationReadOnly')}</CardDescription>
            </CardHeader>
            <CardContent>
              <ReviewEvaluationPanel
                reviewId={detail.id}
                target="review"
                current={evaluations ? evaluations.review.current : detail.review_evaluation}
                history={
                  evaluations?.review.history ??
                  (detail.review_evaluation ? [detail.review_evaluation] : [])
                }
                disabled={
                  !detail.artifact.available ||
                  detail.status !== 'completed' ||
                  evaluations === null
                }
                disabledReason={
                  !detail.artifact.available
                    ? 'artifact'
                    : detail.status !== 'completed'
                      ? 'incomplete'
                      : 'evaluations'
                }
              />
            </CardContent>
          </Card>
          <ExecutionFacts detail={detail} t={t} />
        </aside>
      </div>
    </div>
  );
}

function ExecutionMetadata({ detail, t }: { detail: ReviewDetail; t: (key: string) => string }) {
  const values = [
    [t('baseSha'), detail.base_sha ?? '—'],
    [t('headSha'), detail.head_sha],
    [t('model'), detail.model ?? '—'],
    [t('reasoning'), detail.reasoning ?? '—'],
    [t('promptVersion'), detail.prompt_version ?? '—'],
    [t('promptHash'), detail.prompt_hash ?? '—'],
    [t('schemaVersion'), detail.schema_version ?? '—'],
    [t('schemaHash'), detail.schema_hash ?? '—'],
    [t('attempt'), detail.attempt === null ? '—' : `#${detail.attempt}`],
    [t('duration'), formatDuration(detail.review_started_at, detail.review_completed_at)],
    [t('created'), <RelativeTime key="created-time" value={detail.created_at} />],
    [t('completed'), <RelativeTime key="completed-time" value={detail.review_completed_at} />],
    [t('publication'), detail.published_at ? t('completed') : t('notPublished')],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('executionMetadata')}</CardTitle>
      </CardHeader>
      <CardContent className="grid min-w-0 gap-4 sm:grid-cols-2">
        {values.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <p className="text-xs text-muted-foreground">{label}</p>
            <div className="mt-1 flex min-w-0 items-center gap-1 text-sm">
              <span className="min-w-0 break-all">{value}</span>
              {(label === t('baseSha') || label === t('headSha')) && typeof value === 'string' ? (
                <CopyShaButton value={value} label={`${t('copy')} ${label}`} />
              ) : null}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function StatusNotice({ detail, t }: { detail: ReviewDetail; t: (key: string) => string }) {
  const key = `${detail.status}Description`;
  return (
    <Alert variant={detail.status === 'failed' ? 'destructive' : 'default'}>
      <AlertTitle>{t(detail.status)}</AlertTitle>
      <AlertDescription>{t(key)}</AlertDescription>
    </Alert>
  );
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) {
    return '—';
  }
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
}

function UnavailableState({ detail, t }: { detail: ReviewDetail; t: (key: string) => string }) {
  return (
    <Alert>
      <AlertTitle>{t('artifactUnavailable')}</AlertTitle>
      <AlertDescription>
        {detail.artifact.unavailable_reason ?? t('artifactUnavailableDescription')}
      </AlertDescription>
    </Alert>
  );
}

function Findings({
  detail,
  t,
  evaluations,
}: {
  detail: ReviewDetail;
  t: (key: string) => string;
  evaluations: EvaluationsResponse | null;
}) {
  if (!detail.artifact.available) {
    return null;
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('findings')}</CardTitle>
        <CardDescription>
          {detail.artifact.findings.length === 0
            ? t('noFindings')
            : `${detail.artifact.findings.length} ${t('findingCount')}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {detail.artifact.findings.length === 0 ? (
          <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('noActionableDefects')}
          </p>
        ) : (
          detail.artifact.findings.map((finding) => (
            <article
              key={finding.fingerprint}
              className="min-w-0 rounded-lg border border-border p-4"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="break-all font-mono text-xs text-muted-foreground">
                    {finding.file}:{finding.line} · {finding.fingerprint}
                  </p>
                  <h3 className="mt-1 break-words font-medium">{finding.title}</h3>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className="text-xs text-muted-foreground">{t('severity')}</span>
                  <Badge
                    variant={
                      finding.severity === 'critical' || finding.severity === 'high'
                        ? 'destructive'
                        : 'outline'
                    }
                  >
                    {t(finding.severity)}
                  </Badge>
                  <span className="text-xs text-muted-foreground">{t('confidence')}</span>
                  <Badge variant="outline">{t(finding.confidence)}</Badge>
                  <Badge variant="outline">{t(finding.state ?? 'open')}</Badge>
                  {finding.thread_resolution ? (
                    <Badge variant="outline">
                      {t(`thread_resolution_${finding.thread_resolution.state}`)}
                    </Badge>
                  ) : null}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap break-words text-sm leading-6">
                {finding.explanation}
              </p>
              <Collapsible className="mt-4">
                <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-muted">
                  {t('evidence')}
                  <ChevronDownIcon aria-hidden="true" className="size-4" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-3 space-y-3 text-sm">
                  <pre className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-md bg-muted p-3">
                    {finding.evidence}
                  </pre>
                  <p className="text-muted-foreground">
                    {t('suggestedAction')}: {finding.suggested_action}
                  </p>
                  <FindingContext reviewId={detail.id} fingerprint={finding.fingerprint} />
                  <ReviewEvaluationPanel
                    reviewId={detail.id}
                    target="finding"
                    fingerprint={finding.fingerprint}
                    current={evaluations?.findings[finding.fingerprint]?.current ?? null}
                    fallbackVerdict={evaluations === null ? finding.evaluation : null}
                    history={evaluations?.findings[finding.fingerprint]?.history ?? []}
                    disabled={detail.status !== 'completed' || evaluations === null}
                    disabledReason={
                      !detail.artifact.available
                        ? 'artifact'
                        : detail.status !== 'completed'
                          ? 'incomplete'
                          : 'evaluations'
                    }
                  />
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
                </CollapsibleContent>
              </Collapsible>
            </article>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function Coverage({ detail, t }: { detail: ReviewDetail; t: (key: string) => string }) {
  const coverage = detail.artifact.coverage;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('coverage')}</CardTitle>
        <CardDescription>
          {coverage?.complete ? t('coverageComplete') : t('coverageIncomplete')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {coverage ? (
          <div className="grid gap-4 sm:grid-cols-3">
            <FileList title={t('changedFiles')} values={coverage.changed_files} t={t} />
            <FileList title={t('reviewedFiles')} values={coverage.reviewed_files} t={t} />
            <FileList title={t('omittedFiles')} values={coverage.omitted_files} t={t} />
          </div>
        ) : (
          <p className="text-muted-foreground">{t('coverageUnavailable')}</p>
        )}
        {detail.artifact.limitations.length > 0 ? (
          <>
            <Separator />
            <div>
              <p className="font-medium">{t('limitations')}</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-muted-foreground">
                {detail.artifact.limitations.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
        {detail.artifact.tests_run.length > 0 ? (
          <>
            <Separator />
            <div>
              <p className="font-medium">{t('testsRun')}</p>
              <ul className="mt-2 space-y-2 text-muted-foreground">
                {detail.artifact.tests_run.map((test) => (
                  <li key={test.command} className="min-w-0">
                    <Collapsible>
                      <CollapsibleTrigger className="flex w-full min-w-0 items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left hover:bg-muted">
                        <span className="min-w-0 truncate">
                          <code>{test.command}</code> · {t(test.status)}
                        </span>
                        <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0" />
                      </CollapsibleTrigger>
                      <CollapsibleContent className="mt-2 max-w-full overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                        {test.evidence}
                      </CollapsibleContent>
                    </Collapsible>
                  </li>
                ))}
              </ul>
            </div>
          </>
        ) : null}
      </CardContent>
    </Card>
  );
}

function FileList({
  title,
  values,
  t,
}: {
  title: string;
  values: string[];
  t: (key: string) => string;
}) {
  const list = values.length ? (
    values.map((value) => (
      <li key={value} className="break-all font-mono text-xs">
        {value}
      </li>
    ))
  ) : (
    <li>—</li>
  );
  if (values.length <= 8) {
    return (
      <div className="min-w-0">
        <p className="font-medium">
          {title} ({values.length})
        </p>
        <ul className="mt-2 space-y-1 text-muted-foreground">{list}</ul>
      </div>
    );
  }
  return (
    <div className="min-w-0">
      <Collapsible>
        <CollapsibleTrigger className="flex w-full items-center justify-between text-left font-medium hover:underline">
          {title} ({values.length}) · {t('showFiles')}
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <ul className="mt-2 space-y-1 text-muted-foreground">{list}</ul>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ExecutionFacts({ detail, t }: { detail: ReviewDetail; t: (key: string) => string }) {
  const rows = [
    [t('status'), t(detail.status)],
    [t('attempt'), detail.attempt === null ? '—' : `#${detail.attempt}`],
    [t('started'), <RelativeTime key="started" value={detail.review_started_at} />],
    [t('completed'), <RelativeTime key="completed" value={detail.review_completed_at} />],
    [t('publication'), detail.published_at ? t('published') : t('notPublished')],
    [t('action'), detail.action ?? '—'],
    [
      t('publicationStarted'),
      <RelativeTime key="publication-started" value={detail.publication_started_at} />,
    ],
    [t('publishedAt'), <RelativeTime key="published-at" value={detail.published_at} />],
    [t('publishedReviewId'), detail.published_review_id ? `#${detail.published_review_id}` : '—'],
    [t('artifactHash'), detail.artifact.content_hash ?? '—'],
    [t('errorCode'), detail.error_code ?? '—'],
    [t('supersededBy'), detail.superseded_by_job_id ? `#${detail.superseded_by_job_id}` : '—'],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('execution')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-start justify-between gap-3">
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right">{value}</span>
          </div>
        ))}
        {detail.error_excerpt ? (
          <Alert variant="destructive">
            <AlertTitle>{t('failure')}</AlertTitle>
            <AlertDescription>{detail.error_excerpt}</AlertDescription>
          </Alert>
        ) : null}
      </CardContent>
    </Card>
  );
}

function githubLocationUrl(detail: ReviewDetail, file: string, line: number): string {
  const repository = detail.repository.split('/').map(encodeURIComponent).join('/');
  const path = file.split('/').map(encodeURIComponent).join('/');
  return `https://github.com/${repository}/blob/${encodeURIComponent(detail.head_sha)}/${path}#L${line}`;
}
