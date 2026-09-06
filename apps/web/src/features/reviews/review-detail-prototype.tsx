import type { EvaluationsResponse, ReviewDetail } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Separator } from '@repo/ui/components/separator';
import { ArrowLeftIcon, ChevronDownIcon, ExternalLinkIcon } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { Link } from '../../i18n/navigation';
import { ReviewDetailPrototypeActivity } from './review-detail-prototype-activity';
import { ReviewEvaluationPanel } from './review-evaluation';
import { ReviewPageFrame } from './review-page-frame';

type Layout = 'single' | 'rail';

export async function ReviewDetailPrototype({
  detail,
  evaluations,
  layout,
  returnQuery = '',
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
  layout: Layout;
  returnQuery?: string;
}) {
  const t = await getTranslations('reviewDetail');
  const githubUrl = `https://github.com/${detail.repository}/pull/${detail.pull_request_number}`;
  const completed = detail.status === 'completed';
  const running = detail.status === 'running';
  const failed = detail.status === 'failed';

  const main = (
    <div className="min-w-0 space-y-5">
      <RunOverview detail={detail} />

      {running || failed ? (
        <PrimarySurface>
          <ReviewDetailPrototypeActivity reviewId={detail.id} mode={running ? 'live' : 'recent'} />
        </PrimarySurface>
      ) : null}

      {completed && detail.artifact.available ? (
        <PrimarySurface>
          <ResultSection detail={detail} evaluations={evaluations} />
          <Separator />
          <VerificationSection detail={detail} />
        </PrimarySurface>
      ) : null}

      {completed ? (
        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center justify-between rounded-xl border border-border/75 bg-surface px-5 py-4 text-left text-sm font-medium hover:bg-muted/40">
            실행 로그 보기
            <ChevronDownIcon className="size-4" aria-hidden="true" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-3 rounded-2xl border border-border/75 bg-surface p-6">
            <ReviewDetailPrototypeActivity reviewId={detail.id} mode="recent" />
          </CollapsibleContent>
        </Collapsible>
      ) : null}

      {layout === 'single' && completed ? (
        <PrimarySurface>
          <ReviewEvaluationSection detail={detail} evaluations={evaluations} />
        </PrimarySurface>
      ) : null}

      <TechnicalDetails detail={detail} />
    </div>
  );

  return (
    <ReviewPageFrame className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Link
          href={`/reviews${returnQuery ? `?${returnQuery}` : ''}`}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeftIcon className="size-4" aria-hidden="true" />
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

      <header className="border-b border-border pb-5">
        <p className="text-sm text-muted-foreground">
          {detail.repository} · {t('pullRequest')} #{detail.pull_request_number}
        </p>
        <h1 className="mt-2 max-w-5xl break-words text-2xl font-semibold tracking-tight sm:text-3xl">
          {detail.pull_request_title ?? t('untitled')}
        </h1>
      </header>

      {layout === 'single' ? (
        main
      ) : (
        <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_18rem]">
          {main}
          <aside
            className="min-w-0 space-y-5 xl:sticky xl:top-20 xl:self-start"
            aria-label="Run context"
          >
            <RunContext detail={detail} />
            {completed ? (
              <ReviewEvaluationSection detail={detail} evaluations={evaluations} />
            ) : null}
          </aside>
        </div>
      )}
    </ReviewPageFrame>
  );
}

function PrimarySurface({ children }: { children: React.ReactNode }) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface px-6 py-6 shadow-sm shadow-foreground/[0.025] sm:px-7">
      {children}
    </section>
  );
}

function RunOverview({ detail }: { detail: ReviewDetail }) {
  const state = statusCopy(detail);
  return (
    <section className="rounded-2xl border border-border/75 bg-surface px-6 py-6 shadow-sm shadow-foreground/[0.025] sm:px-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className={`size-2 rounded-full ${state.dot}`} aria-hidden="true" />
            <p className="text-sm font-semibold text-muted-foreground">{state.label}</p>
          </div>
          <p className="mt-2 text-2xl font-bold tracking-[-0.035em]">{state.headline}</p>
          <p className="mt-2 text-sm text-muted-foreground">{state.description}</p>
        </div>
        {detail.review_started_at ? (
          <div className="text-right text-xs text-muted-foreground">
            <p>시작 {formatClock(detail.review_started_at)}</p>
            {detail.review_completed_at ? (
              <p className="mt-1">완료 {formatClock(detail.review_completed_at)}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {detail.error_excerpt ? (
        <p className="mt-4 border-t border-border/70 pt-4 text-sm text-danger">
          {detail.error_excerpt}
        </p>
      ) : null}
    </section>
  );
}

function ResultSection({
  detail,
  evaluations,
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
}) {
  const artifact = detail.artifact;
  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-[-0.025em]">리뷰 결과</h2>
          <p className="mt-1 text-sm text-muted-foreground">{artifact.summary}</p>
        </div>
        <p className="text-sm font-semibold tabular-nums">{artifact.findings.length} findings</p>
      </div>

      <div className="mt-5 divide-y divide-border/70 border-y border-border/70">
        {artifact.findings.length ? (
          artifact.findings.map((finding) => (
            <article key={finding.fingerprint} className="py-5 first:pt-4 last:pb-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  <Badge
                    variant={
                      finding.severity === 'high' || finding.severity === 'critical'
                        ? 'destructive'
                        : 'outline'
                    }
                  >
                    {finding.severity}
                  </Badge>
                  <div className="min-w-0">
                    <p className="font-mono text-xs text-muted-foreground">
                      {finding.file}:{finding.line}
                    </p>
                    <h3 className="mt-1 font-semibold">{finding.title}</h3>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground">
                  confidence {finding.confidence}
                </span>
              </div>
              <p className="mt-3 max-w-5xl text-sm leading-6">{finding.explanation}</p>
              <ReviewEvaluationPanel
                reviewId={detail.id}
                target="finding"
                fingerprint={finding.fingerprint}
                current={evaluations?.findings[finding.fingerprint]?.current ?? null}
                fallbackVerdict={evaluations === null ? finding.evaluation : null}
                history={evaluations?.findings[finding.fingerprint]?.history ?? []}
                disabled={evaluations === null}
                disabledReason="evaluations"
              />
              <Collapsible className="mt-3">
                <CollapsibleTrigger className="flex items-center gap-2 py-2 text-sm text-muted-foreground hover:text-foreground">
                  근거와 코드 컨텍스트
                  <ChevronDownIcon className="size-4" aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-2 rounded-xl bg-muted/50 p-4 text-sm">
                  <p>{finding.evidence}</p>
                  <p className="mt-2 text-muted-foreground">제안: {finding.suggested_action}</p>
                </CollapsibleContent>
              </Collapsible>
            </article>
          ))
        ) : (
          <p className="py-6 text-sm text-muted-foreground">실행 가능한 finding이 없습니다.</p>
        )}
      </div>
    </section>
  );
}

function VerificationSection({ detail }: { detail: ReviewDetail }) {
  const coverage = detail.artifact.coverage;
  const passed = detail.artifact.tests_run.filter((test) => test.status === 'passed').length;
  return (
    <section className="pt-6">
      <h2 className="text-lg font-semibold">검증</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-3">
        <Fact label="테스트" value={`${passed}/${detail.artifact.tests_run.length} 통과`} />
        <Fact
          label="Coverage"
          value={
            coverage
              ? `${coverage.reviewed_files.length}/${coverage.changed_files.length} 파일 검토`
              : '정보 없음'
          }
        />
        <Fact label="GitHub" value={detail.published_at ? '리뷰 게시 완료' : '미게시'} />
      </div>
      {detail.artifact.limitations.length ? (
        <p className="mt-4 text-sm text-warning">제한사항 {detail.artifact.limitations.length}개</p>
      ) : null}
    </section>
  );
}

function ReviewEvaluationSection({
  detail,
  evaluations,
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
}) {
  return (
    <section aria-label="Review evaluation">
      <h2 className="text-lg font-semibold">이번 리뷰는 어땠나요?</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Leverframe 리뷰 품질에 대한 피드백입니다.
      </p>
      <ReviewEvaluationPanel
        reviewId={detail.id}
        target="review"
        current={evaluations ? evaluations.review.current : detail.review_evaluation}
        history={
          evaluations?.review.history ??
          (detail.review_evaluation ? [detail.review_evaluation] : [])
        }
        disabled={evaluations === null}
        disabledReason="evaluations"
      />
    </section>
  );
}

function RunContext({ detail }: { detail: ReviewDetail }) {
  return (
    <section className="rounded-2xl border border-border/75 bg-surface p-5 shadow-sm shadow-foreground/[0.025]">
      <h2 className="text-base font-bold">이 실행</h2>
      <dl className="mt-4 divide-y divide-border/70 text-sm">
        <FactRow label="상태" value={detail.status} />
        <FactRow label="모델" value={detail.model ?? '—'} />
        <FactRow label="시도" value={detail.attempt === null ? '—' : `#${detail.attempt}`} />
        <FactRow label="게시" value={detail.published_at ? '완료' : '—'} />
      </dl>
    </section>
  );
}

function TechnicalDetails({ detail }: { detail: ReviewDetail }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left text-sm text-muted-foreground hover:text-foreground">
        기술 정보
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 border-t border-border/70 py-4 text-xs text-muted-foreground sm:grid-cols-2">
        <p>Head SHA · {detail.head_sha}</p>
        <p>Base SHA · {detail.base_sha ?? '—'}</p>
        <p>Model · {detail.model ?? '—'}</p>
        <p>Reasoning · {detail.reasoning ?? '—'}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium">{value}</p>
    </div>
  );
}

function FactRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  );
}

function statusCopy(detail: ReviewDetail) {
  if (detail.status === 'running') {
    return {
      label: '리뷰 진행 중',
      headline: 'Leverframe이 이 PR을 리뷰하고 있어요',
      description: '아래 활동이 계속 업데이트되면 리뷰 봇이 정상적으로 작업 중입니다.',
      dot: 'bg-info animate-pulse',
    };
  }
  if (detail.status === 'completed') {
    return {
      label: '리뷰 완료',
      headline: `${detail.artifact.findings.length}개의 finding을 확인했어요`,
      description: detail.published_at
        ? '리뷰 결과가 GitHub에 게시되었습니다.'
        : '리뷰 결과가 준비되었습니다.',
      dot: 'bg-success',
    };
  }
  if (detail.status === 'failed') {
    return {
      label: '리뷰 실패',
      headline: '리뷰 결과를 만들지 못했어요',
      description: '마지막 활동을 확인하면 중단되기 직전에 무엇을 하고 있었는지 볼 수 있습니다.',
      dot: 'bg-danger',
    };
  }
  return {
    label: detail.status,
    headline: '리뷰 실행 상태를 확인하세요',
    description: '현재 실행 정보를 표시하고 있습니다.',
    dot: 'bg-muted-foreground',
  };
}

function formatClock(value: string): string {
  return new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(
    new Date(value),
  );
}
