'use client';

import type { Dispatch, ReactNode, SetStateAction } from 'react';
import { type ReviewEvaluation, evaluationWriteResponseSchema } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Separator } from '@repo/ui/components/separator';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import { ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { registerDirtyNavigation } from '../../lib/dirty-navigation';
import { EvaluationTime } from './evaluation-time';
import { useEvaluationTransport } from './evaluation-transport';

type Presentation = 'compact' | 'rail' | 'inline';
type Target = 'review' | 'finding';
type Translator = ReturnType<typeof useTranslations<'reviewDetail'>>;

type Props = {
  reviewId: number;
  target: Target;
  fingerprint?: string;
  current: ReviewEvaluation | null;
  fallbackVerdict?: string | null;
  history: ReviewEvaluation[];
  disabled?: boolean;
  disabledReason?: 'artifact' | 'incomplete' | 'evaluations';
  presentation?: Presentation;
};

type PresentationProps = {
  t: Translator;
  target: Target;
  verdicts: readonly string[];
  verdict: string;
  setVerdict: Dispatch<SetStateAction<string>>;
  rationale: string;
  setRationale: Dispatch<SetStateAction<string>>;
  saving: boolean;
  disabled: boolean;
  activeEvaluation: ReviewEvaluation | null;
  dirty: boolean;
  disabledCopy: string | null;
  feedback: ReactNode;
  onSave: () => void;
  onWithdraw: () => void;
};

export function ReviewEvaluationPanel({
  reviewId,
  target,
  fingerprint,
  current,
  fallbackVerdict = null,
  history,
  disabled = false,
  disabledReason,
  presentation = 'compact',
}: Props) {
  const t = useTranslations('reviewDetail');
  const verdicts =
    target === 'review'
      ? (['useful', 'mixed', 'not_useful', 'unable_to_assess'] as const)
      : (['valid', 'partially_valid', 'false_positive', 'unable_to_verify'] as const);
  const transport = useEvaluationTransport();
  const initialVerdict = current?.verdict ?? fallbackVerdict ?? '';
  const [verdict, setVerdict] = useState<string>(initialVerdict);
  const [rationale, setRationale] = useState(current?.rationale ?? '');
  const [baselineVerdict, setBaselineVerdict] = useState(initialVerdict);
  const [baselineRationale, setBaselineRationale] = useState(current?.rationale ?? '');
  const [activeEvaluation, setActiveEvaluation] = useState(current);
  const [evaluationHistory, setEvaluationHistory] = useState(() =>
    [...history].sort((left, right) => right.id - left.id),
  );
  const [previousId, setPreviousId] = useState<number | null>(
    () => current?.id ?? latestRevisionId(history),
  );
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dirty = !disabled && (verdict !== baselineVerdict || rationale !== baselineRationale);

  useEffect(() => {
    if (!dirty) {
      return;
    }
    const unregisterNavigation = registerDirtyNavigation(t('evaluationUnsavedConfirm'));

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };

    window.addEventListener('beforeunload', handler);
    return () => {
      unregisterNavigation();
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty, t]);

  async function save() {
    if (!verdict || disabled) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    const path = evaluationPath(target, reviewId, fingerprint);
    try {
      const response = await transport(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verdict,
          rationale: rationale || undefined,
          expected_previous_id: previousId,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(response.status === 409 ? t('evaluationConflict') : t('evaluationSaveFailed'));
        return;
      }
      const parsed = evaluationWriteResponseSchema.safeParse(body);
      if (!parsed.success) {
        setError(t('evaluationSaveFailed'));
        return;
      }
      setMessage(t('evaluationSaved'));
      setActiveEvaluation(parsed.data.current);
      setEvaluationHistory((existing) => addRevision(existing, parsed.data.revision));
      const next = parsed.data.current;
      setPreviousId(next?.id ?? null);
      setBaselineVerdict(next?.verdict ?? verdict);
      setBaselineRationale(next?.rationale ?? rationale);
      setRationale(next?.rationale ?? rationale);
    } catch {
      setError(t('evaluationSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function withdraw() {
    if (!activeEvaluation || previousId === null || disabled) {
      return;
    }
    setSaving(true);
    setError(null);
    setMessage(null);
    const path = evaluationPath(target, reviewId, fingerprint);
    try {
      const response = await transport(path, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_previous_id: previousId }),
      });
      if (!response.ok) {
        setError(response.status === 409 ? t('evaluationConflict') : t('evaluationSaveFailed'));
        return;
      }
      const body: unknown = await response.json();
      const parsed = evaluationWriteResponseSchema.safeParse(body);
      if (!parsed.success) {
        setError(t('evaluationSaveFailed'));
        return;
      }
      setEvaluationHistory((existing) => addRevision(existing, parsed.data.revision));
      setActiveEvaluation(null);
      setVerdict('');
      setRationale('');
      setPreviousId(parsed.data.revision.id);
      setBaselineVerdict('');
      setBaselineRationale('');
      setMessage(t('evaluationWithdrawn'));
    } catch {
      setError(t('evaluationSaveFailed'));
    } finally {
      setSaving(false);
    }
  }

  const disabledCopy = disabled
    ? t(
        disabledReason === 'artifact'
          ? 'evaluationUnavailableArtifact'
          : disabledReason === 'incomplete'
            ? 'evaluationUnavailableIncomplete'
            : 'evaluationUnavailableEvaluations',
      )
    : null;
  const feedback = (
    <EvaluationFeedback
      t={t}
      message={message}
      error={error}
      activeEvaluation={activeEvaluation}
      history={evaluationHistory}
    />
  );
  const shared: PresentationProps = {
    t,
    target,
    verdicts,
    verdict,
    setVerdict,
    rationale,
    setRationale,
    saving,
    disabled,
    activeEvaluation,
    dirty,
    disabledCopy,
    feedback,
    onSave: () => void save(),
    onWithdraw: () => void withdraw(),
  };

  if (presentation === 'rail') {
    return <RailEvaluationPresentation {...shared} />;
  }
  if (presentation === 'inline') {
    return <InlineEvaluationPresentation {...shared} />;
  }
  return <CompactEvaluationPresentation {...shared} />;
}

function RailEvaluationPresentation(props: PresentationProps) {
  const {
    t,
    target,
    verdicts,
    verdict,
    setVerdict,
    rationale,
    setRationale,
    saving,
    disabled,
    activeEvaluation,
    dirty,
    disabledCopy,
    feedback,
    onSave,
    onWithdraw,
  } = props;
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Separator />
      <RadioOptions
        t={t}
        target={target}
        verdicts={verdicts}
        verdict={verdict}
        setVerdict={setVerdict}
        saving={saving}
        disabled={disabled}
        layout="list"
      />
      <Textarea
        value={rationale}
        disabled={disabled || saving}
        maxLength={4000}
        onChange={(event) => setRationale(event.target.value)}
        placeholder={t('friendlyRationalePlaceholder')}
        aria-label={t('rationale')}
        className="min-h-24 resize-none border-0 bg-muted/70 shadow-none"
      />
      <Button
        type="button"
        disabled={disabled || saving || !verdict}
        className="h-11 w-full rounded-xl font-semibold"
        onClick={onSave}
      >
        {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
        {t('saveEvaluationFriendly')}
      </Button>
      {activeEvaluation ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || saving || dirty}
          onClick={onWithdraw}
          className="self-start text-muted-foreground"
        >
          {t('withdrawEvaluation')}
        </Button>
      ) : null}
      {disabledCopy ? <p className="text-xs text-muted-foreground">{disabledCopy}</p> : null}
      {feedback}
    </div>
  );
}

function InlineEvaluationPresentation(props: PresentationProps) {
  const {
    t,
    target,
    verdicts,
    verdict,
    setVerdict,
    rationale,
    setRationale,
    saving,
    disabled,
    activeEvaluation,
    dirty,
    disabledCopy,
    feedback,
    onSave,
    onWithdraw,
  } = props;
  const [open, setOpen] = useState(false);
  const currentLabel = activeEvaluation?.verdict
    ? friendlyLabel(t, target, activeEvaluation.verdict)
    : null;
  return (
    <div className="contents">
      <button
        type="button"
        aria-expanded={open}
        disabled={disabled || saving}
        className="order-1 inline-flex h-8 items-center rounded-lg px-2 text-sm font-semibold text-link transition-colors hover:bg-muted hover:text-link disabled:opacity-50"
        onClick={() => setOpen((value) => !value)}
      >
        {activeEvaluation ? t('editFindingEvaluation') : t('evaluateFinding')}
        {currentLabel ? ` · ${currentLabel}` : ''}
      </button>
      {open ? (
        <div className="order-2 mt-1 w-full max-w-5xl basis-full rounded-xl border border-border/70 bg-surface-subtle p-4 sm:p-5">
          <RadioOptions
            t={t}
            target={target}
            verdicts={verdicts}
            verdict={verdict}
            setVerdict={setVerdict}
            saving={saving}
            disabled={disabled}
            layout="grid"
          />
          <Textarea
            value={rationale}
            disabled={disabled || saving}
            maxLength={4000}
            onChange={(event) => setRationale(event.target.value)}
            placeholder={t('friendlyFindingRationalePlaceholder')}
            aria-label={t('rationale')}
            className="mt-3 min-h-20 resize-none bg-background/80"
          />
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={disabled || saving || !verdict}
              onClick={onSave}
            >
              {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              {t('saveEvaluation')}
            </Button>
            {activeEvaluation ? (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={disabled || saving || dirty}
                onClick={onWithdraw}
              >
                {t('withdrawEvaluation')}
              </Button>
            ) : null}
          </div>
          {disabledCopy ? (
            <p className="mt-2 text-xs text-muted-foreground">{disabledCopy}</p>
          ) : null}
          <div className="mt-3 flex flex-col gap-2">{feedback}</div>
        </div>
      ) : disabledCopy ? (
        <p className="order-2 mt-1 w-full basis-full text-xs text-muted-foreground">
          {disabledCopy}
        </p>
      ) : null}
    </div>
  );
}

function CompactEvaluationPresentation(props: PresentationProps) {
  const {
    t,
    verdicts,
    verdict,
    setVerdict,
    rationale,
    setRationale,
    saving,
    disabled,
    activeEvaluation,
    dirty,
    disabledCopy,
    feedback,
    onSave,
    onWithdraw,
  } = props;
  const [rationaleOpen, setRationaleOpen] = useState(false);
  return (
    <div className="mt-4 flex flex-col gap-3">
      <Separator />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <ToggleGroup
          aria-label={t('chooseEvaluation')}
          value={verdict ? [verdict] : []}
          onValueChange={(value) => setVerdict(value[0] ?? '')}
          disabled={disabled || saving}
          variant="outline"
          size="sm"
          className="flex-wrap justify-start"
        >
          {verdicts.map((item) => (
            <ToggleGroupItem key={item} value={item} aria-label={t(item)}>
              {t(item)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={disabled || saving}
            onClick={() => setRationaleOpen((open) => !open)}
          >
            {rationaleOpen
              ? t('hideRationale')
              : rationale
                ? t('editRationale')
                : t('addRationale')}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={disabled || saving || !verdict}
            onClick={onSave}
          >
            {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
            {t('saveEvaluation')}
          </Button>
          {activeEvaluation ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled || saving || dirty}
              onClick={onWithdraw}
            >
              {t('withdrawEvaluation')}
            </Button>
          ) : null}
        </div>
      </div>
      {rationaleOpen ? (
        <Textarea
          value={rationale}
          disabled={disabled || saving}
          maxLength={4000}
          onChange={(event) => setRationale(event.target.value)}
          placeholder={t('rationalePlaceholder')}
          aria-label={t('rationale')}
        />
      ) : rationale ? (
        <p className="line-clamp-2 text-xs leading-5 text-muted-foreground">
          <span className="font-medium text-foreground">{t('rationale')}:</span> {rationale}
        </p>
      ) : null}
      {disabledCopy ? <p className="text-xs text-muted-foreground">{disabledCopy}</p> : null}
      {feedback}
    </div>
  );
}

function RadioOptions({
  t,
  target,
  verdicts,
  verdict,
  setVerdict,
  saving,
  disabled,
  layout,
}: {
  t: Translator;
  target: Target;
  verdicts: readonly string[];
  verdict: string;
  setVerdict: Dispatch<SetStateAction<string>>;
  saving: boolean;
  disabled: boolean;
  layout: 'list' | 'grid';
}) {
  return (
    <div
      role="radiogroup"
      aria-label={t('chooseEvaluation')}
      className={layout === 'grid' ? 'grid gap-2 sm:grid-cols-2' : 'space-y-1.5'}
    >
      {verdicts.map((item) => {
        const selected = verdict === item;
        return (
          <button
            key={item}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={disabled || saving}
            onClick={() => setVerdict(item)}
            className={
              layout === 'grid'
                ? `rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background/60 hover:bg-muted'
                  } disabled:opacity-50`
                : `flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium transition-colors ${
                    selected ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-muted/70'
                  } disabled:cursor-not-allowed disabled:opacity-50`
            }
          >
            {layout === 'list' ? (
              <span
                className={`grid size-4 shrink-0 place-items-center rounded-full border ${
                  selected ? 'border-primary' : 'border-border'
                }`}
                aria-hidden="true"
              >
                {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
            ) : null}
            {friendlyLabel(t, target, item)}
          </button>
        );
      })}
    </div>
  );
}

function EvaluationFeedback({
  t,
  message,
  error,
  activeEvaluation,
  history,
}: {
  t: Translator;
  message: string | null;
  error: string | null;
  activeEvaluation: ReviewEvaluation | null;
  history: ReviewEvaluation[];
}) {
  return (
    <>
      {message ? (
        <p role="status" className="text-sm text-success">
          {message}
        </p>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>{t('evaluationError')}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {activeEvaluation ? (
        <p className="text-xs text-muted-foreground">
          {t('provenance')}: {t('manual')} · <EvaluationTime value={activeEvaluation.created_at} />
        </p>
      ) : null}
      {history.length > 1 ? (
        <Collapsible>
          <CollapsibleTrigger className="flex items-center gap-2 text-xs text-muted-foreground underline underline-offset-4">
            {t('viewHistory')}
            <ChevronDownIcon aria-hidden="true" className="size-3" />
          </CollapsibleTrigger>
          <CollapsibleContent className="mt-2 flex flex-col gap-1 text-xs text-muted-foreground">
            {history.map((revision) => (
              <div key={revision.id}>
                <Badge variant="outline">{t(`${revision.action}EvaluationRevision`)}</Badge>{' '}
                {revision.verdict ? t(revision.verdict) : '—'} ·{' '}
                <EvaluationTime value={revision.created_at} />
                {revision.rationale ? <span> · {revision.rationale}</span> : null}
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </>
  );
}

function friendlyLabel(t: Translator, target: Target, item: string): string {
  return t(`${target === 'review' ? 'friendlyReview' : 'friendlyFinding'}_${item}`);
}

function evaluationPath(target: Target, reviewId: number, fingerprint?: string): string {
  return target === 'review'
    ? `/api/v1/reviews/${reviewId}/evaluation`
    : `/api/v1/reviews/${reviewId}/findings/${fingerprint}/evaluation`;
}

function addRevision(existing: ReviewEvaluation[], revision: ReviewEvaluation): ReviewEvaluation[] {
  return existing.some((item) => item.id === revision.id) ? existing : [revision, ...existing];
}

function latestRevisionId(history: ReviewEvaluation[]): number | null {
  return history.reduce<number | null>(
    (latest, revision) => (latest === null || revision.id > latest ? revision.id : latest),
    null,
  );
}
