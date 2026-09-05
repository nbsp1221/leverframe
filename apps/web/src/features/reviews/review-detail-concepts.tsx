import type { EvaluationsResponse, ReviewDetail } from '@repo/contracts';
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
import { ReviewDetailConceptEvaluation } from './review-detail-concept-evaluation';
import { ReviewPageFrame } from './review-page-frame';

type Concept = 'toss-first' | 'desktop';
type Finding = ReviewDetail['artifact']['findings'][number];

export async function ReviewDetailConcept({
  detail,
  evaluations,
  concept,
  returnQuery = '',
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
  concept: Concept;
  returnQuery?: string;
}) {
  const t = await getTranslations('reviewDetail');
  const githubUrl = `https://github.com/${detail.repository}/pull/${detail.pull_request_number}`;

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
          {detail.repository} · PR #{detail.pull_request_number}
        </p>
        <h1 className="max-w-5xl break-words text-2xl font-bold tracking-[-0.04em] sm:text-3xl">
          {detail.pull_request_title ?? t('untitled')}
        </h1>
        <p className="text-sm text-muted-foreground">
          리뷰 결과를 이해하는 데 필요한 내용부터 보여드려요.
        </p>
      </header>

      {concept === 'toss-first' ? (
        <TossFirstConcept detail={detail} evaluations={evaluations} />
      ) : (
        <DesktopConcept detail={detail} evaluations={evaluations} />
      )}
    </ReviewPageFrame>
  );
}

function TossFirstConcept({
  detail,
  evaluations,
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
}) {
  const findings = sortFindings(detail.artifact.findings);
  const coverage = detail.artifact.coverage;
  const duration = reviewDuration(detail);
  const reviewedCount = coverage?.reviewed_files.length ?? 0;
  const changedCount = coverage?.changed_files.length ?? 0;
  const omittedCount = coverage?.omitted_files.length ?? 0;

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-5">
        <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
          <div className="px-6 py-6 sm:px-7">
            <p className="text-sm font-semibold text-muted-foreground">한눈에 보면</p>
            <h2 className="mt-2 text-2xl font-bold tracking-[-0.045em] text-success sm:text-3xl">
              {findings.length
                ? `${findings.length}개의 finding을 확인했어요`
                : '확인할 finding이 없어요'}
            </h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {findings.length
                ? '중요한 항목부터 아래에서 차례로 확인해보세요.'
                : '검토 범위와 테스트 결과를 확인한 뒤 리뷰를 마무리하면 돼요.'}
            </p>
          </div>
          <div className="grid border-t border-border/70 sm:grid-cols-3 sm:divide-x sm:divide-border/70">
            <Metric label="발견한 문제" value={`${findings.length}개`} />
            <Metric
              label="파일 확인"
              value={coverage ? `${reviewedCount} / ${changedCount}` : '—'}
            />
            <Metric label="걸린 시간" value={duration} />
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
          <SectionHeader title="확인할 내용" description="중요한 순서대로 보여드려요." />
          <div className="px-6 pb-1 sm:px-7">
            {findings.length ? (
              findings.map((finding, index) => (
                <SimpleFindingRow
                  key={finding.fingerprint}
                  index={index + 1}
                  finding={finding}
                  reviewId={detail.id}
                  evaluations={evaluations}
                />
              ))
            ) : (
              <p className="border-t border-border/70 py-6 text-sm text-muted-foreground">
                실행 가능한 finding이 없습니다.
              </p>
            )}
          </div>
        </section>

        <section className="rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
          <SectionHeader
            title="파일과 테스트 확인"
            description={
              coverage?.complete ? '변경된 파일을 모두 확인했어요.' : '검토 범위를 확인해주세요.'
            }
          />
          <div className="px-6 pb-6 sm:px-7">
            <CoverageBar reviewed={reviewedCount} changed={changedCount} omitted={omittedCount} />
            <div className="mt-5 grid gap-4 border-t border-border/70 pt-5 sm:grid-cols-3">
              <CompactFact label="테스트" value={testSummary(detail)} />
              <CompactFact label="누락 파일" value={`${omittedCount}개`} />
              <CompactFact label="GitHub 게시" value={detail.published_at ? '완료' : '미게시'} />
            </div>
          </div>
        </section>

        <TechnicalDisclosure detail={detail} />
      </div>

      <aside className="min-w-0 space-y-5 xl:sticky xl:top-20 xl:self-start">
        <section className="rounded-2xl border border-border/75 bg-surface p-5 shadow-sm shadow-foreground/[0.025]">
          <h2 className="text-lg font-bold tracking-[-0.025em]">이 리뷰가 도움이 됐나요?</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            하나만 고르면 돼요. 이유는 필요할 때만 남겨주세요.
          </p>
          <div className="mt-4 border-t border-border/70 pt-4">
            <ReviewDetailConceptEvaluation
              reviewId={detail.id}
              target="review"
              current={evaluations?.review.current ?? detail.review_evaluation}
              history={
                evaluations?.review.history ??
                (detail.review_evaluation ? [detail.review_evaluation] : [])
              }
              presentation="rail"
            />
          </div>
        </section>
        <RunInfo detail={detail} compact />
      </aside>
    </div>
  );
}

function DesktopConcept({
  detail,
  evaluations,
}: {
  detail: ReviewDetail;
  evaluations: EvaluationsResponse | null;
}) {
  const findings = sortFindings(detail.artifact.findings);
  const coverage = detail.artifact.coverage;
  const reviewedCount = coverage?.reviewed_files.length ?? 0;
  const changedCount = coverage?.changed_files.length ?? 0;

  return (
    <div className="grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1fr)_19rem]">
      <div className="min-w-0 space-y-5">
        <section className="rounded-2xl border border-border/75 bg-surface p-6 shadow-sm shadow-foreground/[0.025] sm:p-7">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="min-w-0 max-w-4xl">
              <p className="inline-flex items-center gap-2 text-sm font-semibold text-success">
                <span className="size-2 rounded-full bg-success" aria-hidden="true" />
                리뷰 완료
              </p>
              <h2 className="mt-2 text-2xl font-bold tracking-[-0.04em]">
                {findings.length
                  ? `${findings.length}개의 항목을 확인해보세요`
                  : '추가로 확인할 항목이 없어요'}
              </h2>
              <p className="mt-2 text-sm leading-6 text-muted-foreground">
                {detail.artifact.summary ?? '저장된 리뷰 요약이 없습니다.'}
              </p>
            </div>
            <div className="grid shrink-0 grid-cols-3 gap-6 text-right">
              <MiniMetric label="Findings" value={String(findings.length)} />
              <MiniMetric
                label="Files"
                value={coverage ? `${reviewedCount}/${changedCount}` : '—'}
              />
              <MiniMetric label="Time" value={reviewDuration(detail)} />
            </div>
          </div>
        </section>

        <section className="overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
          <div className="flex flex-wrap items-end justify-between gap-3 border-b border-border/70 px-6 py-5 sm:px-7">
            <div>
              <h2 className="text-xl font-bold tracking-[-0.025em]">Review findings</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                코드 위치와 영향부터 빠르게 훑어보세요.
              </p>
            </div>
            <span className="text-sm font-semibold tabular-nums">{findings.length} findings</span>
          </div>
          <div>
            {findings.map((finding, index) => (
              <DenseFindingRow
                key={finding.fingerprint}
                index={index + 1}
                finding={finding}
                reviewId={detail.id}
                evaluations={evaluations}
              />
            ))}
          </div>
          <div className="grid border-t border-border/70 bg-muted/20 sm:grid-cols-3 sm:divide-x sm:divide-border/70">
            <Metric label="Tests" value={testSummary(detail)} compact />
            <Metric
              label="Coverage"
              value={coverage ? `${reviewedCount}/${changedCount} files` : '—'}
              compact
            />
            <Metric label="Published" value={detail.published_at ? 'GitHub' : '—'} compact />
          </div>
        </section>

        <TechnicalDisclosure detail={detail} />
      </div>

      <aside className="min-w-0 space-y-5 xl:sticky xl:top-20 xl:self-start">
        <section className="rounded-2xl border border-border/75 bg-surface p-5 shadow-sm shadow-foreground/[0.025]">
          <h2 className="text-lg font-bold tracking-[-0.025em]">리뷰 품질 평가</h2>
          <p className="mt-1.5 text-sm leading-5 text-muted-foreground">
            결과를 확인한 뒤 Leverframe 리뷰가 얼마나 도움이 됐는지 알려주세요.
          </p>
          <div className="mt-4 border-t border-border/70 pt-4">
            <ReviewDetailConceptEvaluation
              reviewId={detail.id}
              target="review"
              current={evaluations?.review.current ?? detail.review_evaluation}
              history={
                evaluations?.review.history ??
                (detail.review_evaluation ? [detail.review_evaluation] : [])
              }
              presentation="rail"
            />
          </div>
        </section>
        <RunInfo detail={detail} />
      </aside>
    </div>
  );
}

function SimpleFindingRow({
  index,
  finding,
  reviewId,
  evaluations,
}: {
  index: number;
  finding: Finding;
  reviewId: number;
  evaluations: EvaluationsResponse | null;
}) {
  return (
    <article className="border-t border-border/70 py-5 first:border-t-0 first:pt-1">
      <div className="flex items-start gap-3">
        <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-muted text-xs font-bold text-muted-foreground">
          {index}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="font-semibold leading-6">{finding.title}</h3>
              <p className="mt-1.5 text-sm leading-6 text-muted-foreground">
                {finding.explanation}
              </p>
            </div>
            <SeverityPill severity={finding.severity} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-4">
            <EvidenceDisclosure finding={finding} />
            <ReviewDetailConceptEvaluation
              reviewId={reviewId}
              target="finding"
              fingerprint={finding.fingerprint}
              current={evaluations?.findings[finding.fingerprint]?.current ?? null}
              history={evaluations?.findings[finding.fingerprint]?.history ?? []}
              presentation="inline"
            />
          </div>
        </div>
      </div>
    </article>
  );
}

function DenseFindingRow({
  index,
  finding,
  reviewId,
  evaluations,
}: {
  index: number;
  finding: Finding;
  reviewId: number;
  evaluations: EvaluationsResponse | null;
}) {
  return (
    <article className="grid gap-4 border-t border-border/70 px-6 py-5 first:border-t-0 sm:px-7 lg:grid-cols-[2.25rem_minmax(0,1fr)_7rem]">
      <span className="grid size-7 place-items-center rounded-lg border border-border text-xs font-semibold text-muted-foreground">
        {index}
      </span>
      <div className="min-w-0">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
          <h3 className="font-semibold">{finding.title}</h3>
          <span className="break-all font-mono text-xs text-muted-foreground">
            {finding.file}:{finding.line}
          </span>
        </div>
        <p className="mt-2 max-w-5xl text-sm leading-6 text-muted-foreground">
          {finding.explanation}
        </p>
        <div className="mt-2 flex flex-wrap items-center gap-4">
          <EvidenceDisclosure finding={finding} />
          <ReviewDetailConceptEvaluation
            reviewId={reviewId}
            target="finding"
            fingerprint={finding.fingerprint}
            current={evaluations?.findings[finding.fingerprint]?.current ?? null}
            history={evaluations?.findings[finding.fingerprint]?.history ?? []}
            presentation="inline"
          />
        </div>
      </div>
      <div className="flex items-start justify-start lg:justify-end">
        <SeverityPill severity={finding.severity} />
      </div>
    </article>
  );
}

function EvidenceDisclosure({ finding }: { finding: Finding }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="inline-flex items-center gap-1.5 py-1 text-sm font-semibold text-link hover:underline">
        근거 보기
        <ChevronDownIcon className="size-3.5" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-2 max-w-3xl rounded-xl bg-muted/60 p-4 text-sm leading-6">
        <p>{finding.evidence}</p>
        <p className="mt-2 text-muted-foreground">
          {finding.file}:{finding.line} · {finding.suggested_action}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function TechnicalDisclosure({ detail }: { detail: ReviewDetail }) {
  return (
    <Collapsible>
      <CollapsibleTrigger className="flex w-full items-center justify-between py-3 text-left text-sm font-medium text-muted-foreground hover:text-foreground">
        실행 로그와 기술 정보
        <ChevronDownIcon className="size-4" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="grid gap-3 border-t border-border/70 py-4 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
        <p>Model · {detail.model ?? '—'}</p>
        <p>Reasoning · {detail.reasoning ?? '—'}</p>
        <p>Attempt · {detail.attempt === null ? '—' : `#${detail.attempt}`}</p>
        <p>Head · {detail.head_sha.slice(0, 10)}</p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunInfo({ detail, compact = false }: { detail: ReviewDetail; compact?: boolean }) {
  return (
    <section className="rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]">
      <div className="px-5 pt-5 pb-3">
        <h2 className="text-base font-bold">실행 정보</h2>
      </div>
      <dl className="px-5 pb-4 text-sm">
        <InfoRow label="상태" value="완료" />
        {!compact ? <InfoRow label="걸린 시간" value={reviewDuration(detail)} /> : null}
        <InfoRow label="모델" value={detail.model ?? '—'} />
        <InfoRow label="시도" value={detail.attempt === null ? '—' : `#${detail.attempt}`} />
        <InfoRow label="게시" value={detail.published_at ? '완료' : '미게시'} />
      </dl>
    </section>
  );
}

function Metric({
  label,
  value,
  compact = false,
}: {
  label: string;
  value: string;
  compact?: boolean;
}) {
  return (
    <div className={compact ? 'px-5 py-4' : 'px-6 py-5 sm:px-7'}>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className={`${compact ? 'mt-1 text-sm' : 'mt-2 text-lg'} font-bold tabular-nums`}>
        {value}
      </p>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs font-semibold text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-bold tabular-nums">{value}</p>
    </div>
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

function CoverageBar({
  reviewed,
  changed,
  omitted,
}: {
  reviewed: number;
  changed: number;
  omitted: number;
}) {
  const percentage = changed === 0 ? 0 : Math.min(100, Math.round((reviewed / changed) * 100));
  return (
    <div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-success" style={{ width: `${percentage}%` }} />
      </div>
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>검토한 파일 {reviewed}개</span>
        <span>누락 {omitted}개</span>
      </div>
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

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 border-t border-border/70 py-3 first:border-t-0 first:pt-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-medium">{value}</dd>
    </div>
  );
}

function SeverityPill({ severity }: { severity: Finding['severity'] }) {
  const label =
    severity === 'critical' || severity === 'high'
      ? '중요'
      : severity === 'medium'
        ? '보통'
        : '낮음';
  const tone =
    severity === 'critical' || severity === 'high'
      ? 'bg-danger-soft text-danger'
      : severity === 'medium'
        ? 'bg-warning-soft text-warning'
        : 'bg-muted text-muted-foreground';
  return <Badge className={`${tone} border-0 shadow-none`}>{label}</Badge>;
}

function sortFindings(findings: Finding[]): Finding[] {
  const order = { critical: 0, high: 1, medium: 2, low: 3 } as const;
  return [...findings].sort((left, right) => order[left.severity] - order[right.severity]);
}

function reviewDuration(detail: ReviewDetail): string {
  if (!detail.review_started_at || !detail.review_completed_at) {
    return '—';
  }
  const seconds = Math.max(
    0,
    Math.round(
      (Date.parse(detail.review_completed_at) - Date.parse(detail.review_started_at)) / 1000,
    ),
  );
  if (seconds < 60) {
    return `${seconds}초`;
  }
  return `${Math.floor(seconds / 60)}분 ${seconds % 60}초`;
}

function testSummary(detail: ReviewDetail): string {
  const tests = detail.artifact.tests_run;
  if (!tests.length) {
    return '실행 안 함';
  }
  const passed = tests.filter((test) => test.status === 'passed').length;
  return `${passed}/${tests.length} 통과`;
}
