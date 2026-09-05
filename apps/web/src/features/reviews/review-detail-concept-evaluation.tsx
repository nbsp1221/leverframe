'use client';

import { type ReviewEvaluation, evaluationWriteResponseSchema } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { useMemo, useState } from 'react';
import { useEvaluationTransport } from './evaluation-transport';

type Target = 'review' | 'finding';
type ReviewVerdict = 'useful' | 'mixed' | 'not_useful' | 'unable_to_assess';
type FindingVerdict = 'valid' | 'partially_valid' | 'false_positive' | 'unable_to_verify';

type Props = {
  reviewId: number;
  target: Target;
  fingerprint?: string;
  current: ReviewEvaluation | null;
  history: ReviewEvaluation[];
  presentation: 'rail' | 'inline';
};

const reviewOptions: Array<{ value: ReviewVerdict; label: string }> = [
  { value: 'useful', label: '유용했어요' },
  { value: 'mixed', label: '조금 아쉬웠어요' },
  { value: 'not_useful', label: '도움이 안 됐어요' },
  { value: 'unable_to_assess', label: '평가하기 어려워요' },
];

const findingOptions: Array<{ value: FindingVerdict; label: string }> = [
  { value: 'valid', label: '맞는 지적이에요' },
  { value: 'partially_valid', label: '일부만 맞아요' },
  { value: 'false_positive', label: '오탐이에요' },
  { value: 'unable_to_verify', label: '확인하기 어려워요' },
];

export function ReviewDetailConceptEvaluation({
  reviewId,
  target,
  fingerprint,
  current,
  history,
  presentation,
}: Props) {
  const options = target === 'review' ? reviewOptions : findingOptions;
  const initialVerdict = current?.verdict ?? '';
  const [verdict, setVerdict] = useState(initialVerdict);
  const [rationale, setRationale] = useState(current?.rationale ?? '');
  const [active, setActive] = useState(current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const transport = useEvaluationTransport();
  const previousId = useMemo(() => {
    if (active?.id) {
      return active.id;
    }
    return history.reduce<number | null>(
      (latest, revision) => (latest === null || revision.id > latest ? revision.id : latest),
      null,
    );
  }, [active, history]);

  async function save() {
    if (!verdict || saving) {
      return;
    }
    setSaving(true);
    setMessage(null);
    setError(null);
    const path =
      target === 'review'
        ? `/api/v1/reviews/${reviewId}/evaluation`
        : `/api/v1/reviews/${reviewId}/findings/${fingerprint}/evaluation`;
    try {
      const response = await transport(path, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          verdict,
          rationale: rationale.trim() || undefined,
          expected_previous_id: previousId,
        }),
      });
      const body: unknown = await response.json();
      if (!response.ok) {
        setError(
          response.status === 409 ? '다른 곳에서 평가가 변경됐어요.' : '평가를 저장하지 못했어요.',
        );
        return;
      }
      const parsed = evaluationWriteResponseSchema.safeParse(body);
      if (!parsed.success) {
        setError('평가를 저장하지 못했어요.');
        return;
      }
      setActive(parsed.data.current);
      setVerdict(parsed.data.current?.verdict ?? verdict);
      setRationale(parsed.data.current?.rationale ?? rationale);
      setMessage('저장했어요.');
    } catch {
      setError('평가를 저장하지 못했어요.');
    } finally {
      setSaving(false);
    }
  }

  if (presentation === 'inline') {
    return (
      <InlineFindingEvaluation
        options={options}
        verdict={verdict}
        rationale={rationale}
        saving={saving}
        message={message}
        error={error}
        onVerdict={setVerdict}
        onRationale={setRationale}
        onSave={() => void save()}
      />
    );
  }

  return (
    <div>
      <div role="radiogroup" aria-label="리뷰 평가" className="space-y-1.5">
        {options.map((option) => {
          const selected = verdict === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={saving}
              onClick={() => setVerdict(option.value)}
              className={`flex w-full items-center gap-3 rounded-xl px-3.5 py-3 text-left text-sm font-medium transition-colors ${
                selected ? 'bg-primary/15 text-primary' : 'text-foreground hover:bg-muted/70'
              }`}
            >
              <span
                className={`grid size-4 shrink-0 place-items-center rounded-full border ${
                  selected ? 'border-primary' : 'border-border'
                }`}
                aria-hidden="true"
              >
                {selected ? <span className="size-2 rounded-full bg-primary" /> : null}
              </span>
              {option.label}
            </button>
          );
        })}
      </div>
      <Textarea
        value={rationale}
        onChange={(event) => setRationale(event.target.value)}
        disabled={saving}
        maxLength={4000}
        aria-label="선택사항 이유"
        placeholder="선택사항 · 간단한 이유를 남겨주세요"
        className="mt-3 min-h-24 resize-none border-0 bg-muted/70 shadow-none"
      />
      <Button
        type="button"
        disabled={!verdict || saving}
        className="mt-3 h-11 w-full rounded-xl font-semibold"
        onClick={() => void save()}
      >
        {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
        평가 저장하기
      </Button>
      {message ? (
        <p role="status" className="mt-2 text-xs text-success">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function InlineFindingEvaluation({
  options,
  verdict,
  rationale,
  saving,
  message,
  error,
  onVerdict,
  onRationale,
  onSave,
}: {
  options: Array<{ value: ReviewVerdict | FindingVerdict; label: string }>;
  verdict: string;
  rationale: string;
  saving: boolean;
  message: string | null;
  error: string | null;
  onVerdict: (value: string) => void;
  onRationale: (value: string) => void;
  onSave: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-3">
      <button
        type="button"
        className="text-sm font-semibold text-link hover:underline"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        {verdict ? '판정 수정' : '판정하기'}
      </button>
      {open ? (
        <div className="mt-3 rounded-xl bg-muted/50 p-4">
          <div role="radiogroup" aria-label="Finding 평가" className="grid gap-2 sm:grid-cols-2">
            {options.map((option) => {
              const selected = verdict === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  disabled={saving}
                  onClick={() => onVerdict(option.value)}
                  className={`rounded-lg border px-3 py-2 text-left text-sm transition-colors ${
                    selected
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background/60 hover:bg-muted'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
          <Textarea
            value={rationale}
            onChange={(event) => onRationale(event.target.value)}
            disabled={saving}
            maxLength={4000}
            aria-label="Finding 평가 이유"
            placeholder="선택사항 · 이유를 남겨주세요"
            className="mt-3 min-h-20 resize-none bg-background/70"
          />
          <div className="mt-3 flex items-center gap-3">
            <Button type="button" size="sm" disabled={!verdict || saving} onClick={onSave}>
              {saving ? <Spinner data-icon="inline-start" aria-hidden="true" /> : null}
              저장
            </Button>
            {message ? (
              <span role="status" className="text-xs text-success">
                {message}
              </span>
            ) : null}
            {error ? (
              <span role="alert" className="text-xs text-danger">
                {error}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
