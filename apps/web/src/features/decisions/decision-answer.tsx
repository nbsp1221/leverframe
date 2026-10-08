'use client';

import type { Decision, DecisionAnswer } from '@repo/contracts/decisions';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@repo/ui/components/field';
import { Textarea } from '@repo/ui/components/textarea';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import { ArrowUpRightIcon, SearchIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { DecisionApiError, answerDecision } from './decision-api';

type Draft = DecisionAnswer;

export function rebaseDecisionDraft(id: string, previousRevision: number, revision: number) {
  try {
    const key = `decision-draft:${id}`;
    const value = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | null;
    if (value?.expectedRevision === previousRevision) {
      sessionStorage.setItem(key, JSON.stringify({ ...value, expectedRevision: revision }));
    }
  } catch {
    // Optional cache: stale drafts still require explicit review before sending.
  }
}

// getRandomValues is also available on the private HTTP development origin.
function answerId(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}

function emptyDraft(item: Decision): Draft {
  return { id: answerId(), expectedRevision: item.revision, intent: 'decide', text: '' };
}

function readDraft(item: Decision): Draft {
  try {
    const raw = sessionStorage.getItem(`decision-draft:${item.id}`);
    if (raw) {
      const value = JSON.parse(raw) as Draft;
      if (
        typeof value.id === 'string' &&
        typeof value.text === 'string' &&
        Number.isInteger(value.expectedRevision) &&
        ['decide', 'research'].includes(value.intent)
      ) {
        return value;
      }
    }
  } catch {
    /* Storage may be disabled; the form still works in memory. */
  }
  return emptyDraft(item);
}

export function DecisionAnswerForm({
  item,
  onChange,
}: {
  item: Decision;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('decisions');
  const [draft, setDraft] = useState(() => readDraft(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stale = draft.expectedRevision !== item.revision;
  const canSubmit =
    draft.text.trim().length > 0 || (draft.intent === 'decide' && Boolean(draft.optionId));

  function update(patch: Partial<Draft>) {
    const value = { ...draft, ...patch, id: answerId() };
    setDraft(value);
    setError(null);
    try {
      sessionStorage.setItem(`decision-draft:${item.id}`, JSON.stringify(value));
    } catch {
      /* Optional draft cache. */
    }
  }

  async function submit() {
    if (busy || !canSubmit || stale) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await answerDecision(item.id, draft);
      try {
        sessionStorage.removeItem(`decision-draft:${item.id}`);
      } catch {
        /* Optional draft cache. */
      }
      await onChange();
    } catch (cause) {
      setError(
        t(cause instanceof DecisionApiError && cause.status === 409 ? 'conflict' : 'sendError'),
      );
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      className="flex flex-col gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{t('yourResponse')}</h3>
          {item.recommendationUnavailableReason && (
            <Badge variant="outline">{t('recommendationWithheld')}</Badge>
          )}
        </div>
        <ToggleGroup
          value={[draft.intent]}
          onValueChange={(values) => {
            const intent = values[0];
            if (intent === 'decide' || intent === 'research') {
              update({ intent, optionId: undefined });
            }
          }}
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={t('responseType')}
        >
          <ToggleGroupItem value="decide">{t('makeDecision')}</ToggleGroupItem>
          <ToggleGroupItem value="research">
            <SearchIcon data-icon="inline-start" />
            {t('askResearch')}
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {draft.intent === 'decide' && item.options.length > 0 && (
        <ToggleGroup
          orientation="vertical"
          value={draft.optionId ? [draft.optionId] : []}
          onValueChange={(values) => update({ optionId: values[0] })}
          variant="outline"
          disabled={busy}
          className="w-full"
          aria-label={t('options')}
        >
          {item.options.map((option) => (
            <ToggleGroupItem
              key={option.id}
              value={option.id}
              className="h-auto w-full justify-start p-3 text-left whitespace-normal"
            >
              <span className="flex min-w-0 flex-col gap-2">
                <span className="flex flex-wrap items-center gap-2">
                  {option.label}
                  {option.recommended && <Badge variant="default">{t('recommended')}</Badge>}
                </span>
                <span className="font-normal">{option.effect}</span>
              </span>
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      )}
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="decision-answer">
            {draft.intent === 'research' ? t('researchLabel') : t('answerLabel')}
          </FieldLabel>
          <Textarea
            id="decision-answer"
            value={draft.text}
            onChange={(event) => update({ text: event.target.value })}
            placeholder={
              draft.intent === 'research' ? t('researchPlaceholder') : t('answerPlaceholder')
            }
            rows={2}
            maxLength={4000}
            disabled={busy}
          />
          <FieldDescription>
            {draft.intent === 'research' ? t('researchHelp') : null}
          </FieldDescription>
        </Field>
      </FieldGroup>
      {stale && (
        <Alert>
          <AlertTitle>{t('changedTitle')}</AlertTitle>
          <AlertDescription>
            {t('changedBody')}
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => update({ expectedRevision: item.revision, optionId: undefined })}
            >
              {t('reviewLatest')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">{t('draftHelp')}</p>
        <Button type="submit" disabled={busy || !canSubmit || stale}>
          {busy ? t('sending') : draft.intent === 'research' ? t('sendResearch') : t('sendAnswer')}
          <ArrowUpRightIcon data-icon="inline-end" />
        </Button>
      </div>
    </form>
  );
}
