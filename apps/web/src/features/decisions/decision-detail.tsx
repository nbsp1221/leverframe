'use client';

import type { Decision } from '@repo/contracts/decisions';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { ArrowLeftIcon, Clock3Icon, RotateCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { ConnectionSettingsLink } from '../../components/connection-settings-link';
import { LocalTime } from '../../components/local-time';
import { DecisionAnswerForm, rebaseDecisionDraft } from './decision-answer';
import { retryDecision, snoozeDecision } from './decision-api';
import { DecisionDisclosure } from './decision-disclosure';

export function DecisionDetail({
  item,
  now,
  onChange,
  onBack,
}: {
  item: Decision;
  now: number;
  onChange: () => Promise<void>;
  onBack: () => void;
}) {
  const t = useTranslations('decisions');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const awaiting = item.status === 'awaiting_answer';
  const deferred = awaiting && Boolean(item.snoozedUntil && Date.parse(item.snoozedUntil) > now);
  const lastAnswer = item.answers.at(-1);
  const lastOption = item.options.find((option) => option.id === lastAnswer?.optionId);
  const lastAnswerEvent = item.events.findLastIndex((event) => event.kind === 'answered');
  const agentResult = item.events
    .slice(lastAnswerEvent + 1)
    .reverse()
    .find((event) => ['needs_input', 'applied', 'investigating'].includes(event.kind));
  // Older stored requests have no separate scope field. Keep their facts visible rather than hiding conditions.
  const constraints = item.constraints.length
    ? item.constraints
    : item.facts.map((fact) => fact.detail);

  async function act(action: 'retry' | 'snooze') {
    setBusy(true);
    setError(false);
    try {
      if (action === 'retry') {
        await retryDecision(item.id, item.revision);
      } else {
        const updated = await snoozeDecision(item.id, item.revision, !deferred);
        rebaseDecisionDraft(item.id, item.revision, updated.revision);
      }
      await onChange();
    } catch {
      setError(true);
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      aria-labelledby="decision-title"
      className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-5 sm:p-7 lg:p-8"
    >
      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="sm" onClick={onBack} className="lg:hidden">
              <ArrowLeftIcon data-icon="inline-start" />
              {t('back')}
            </Button>
            <span className="text-sm font-semibold text-primary">{item.project}</span>
            <Badge variant="secondary">{deferred ? t('later') : t(`status.${item.status}`)}</Badge>
          </div>
          {awaiting && (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => {
                void act('snooze');
              }}
            >
              <Clock3Icon data-icon="inline-start" />
              {t(deferred ? 'wake' : 'snooze')}
            </Button>
          )}
        </div>
        <h2
          id="decision-title"
          className="text-xl leading-relaxed font-semibold tracking-tight sm:text-2xl"
        >
          {awaiting ? item.question : item.title}
        </h2>
        {awaiting && !lastAnswer && (
          <p className="text-sm leading-6 text-muted-foreground">{item.why}</p>
        )}
      </header>

      {deferred && (
        <Alert>
          <AlertTitle>{t('snoozedTitle')}</AlertTitle>
          <AlertDescription>
            {t('snoozedHelp')} <LocalTime value={item.snoozedUntil!} />
          </AlertDescription>
        </Alert>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {t('sendError')}
        </p>
      )}

      {lastAnswer && (
        <section
          aria-label={t('lastAnswer')}
          className="flex flex-col gap-2 border-l-2 border-primary pl-4"
        >
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('lastAnswer')} ·{' '}
            {t(lastAnswer.intent === 'research' ? 'askResearch' : 'makeDecision')}
          </h3>
          {lastOption && (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-sm font-medium">{lastOption.label}</p>
              {lastOption.recommended && <Badge>{t('recommended')}</Badge>}
            </div>
          )}
          {lastAnswer.text && (
            <p className="text-sm leading-6 break-words whitespace-pre-wrap">{lastAnswer.text}</p>
          )}
        </section>
      )}

      {!awaiting && (
        <Alert>
          <AlertTitle>{t(`next.${item.status}`)}</AlertTitle>
          <AlertDescription>
            {item.status === 'delivery_failed' && item.deliveryIssue
              ? t(`deliveryIssue.${item.deliveryIssue}`)
              : t(`explanation.${item.status}`)}
            {item.status === 'delivery_failed' && item.deliveryIssue === 'offline' && (
              <ConnectionSettingsLink>{t('checkConnection')}</ConnectionSettingsLink>
            )}
            {item.status === 'delivery_failed' && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                onClick={() => {
                  void act('retry');
                }}
              >
                <RotateCwIcon data-icon="inline-start" />
                {busy
                  ? t('sending')
                  : item.deliveryIssue === 'unconfirmed'
                    ? t('checkReceipt')
                    : t('retry')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {agentResult && (
        <section aria-label={t('agentUpdate')} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{t(awaiting ? 'whatChanged' : 'agentUpdate')}</h3>
          <p className="text-sm leading-7 whitespace-pre-wrap">{agentResult.text}</p>
        </section>
      )}

      {awaiting && (
        <>
          <section aria-label={t('scope')} className="flex flex-col gap-2 text-sm leading-6">
            <h3 className="text-xs font-semibold text-muted-foreground">{t('scope')}</h3>
            {constraints.map((condition) => (
              <p key={condition}>{condition}</p>
            ))}
            {item.assumption && <p>{item.assumption}</p>}
            <p className="text-muted-foreground">
              <span className="font-medium">{t('waitingWork')}: </span>
              {item.waitingFor}
            </p>
          </section>
          {!deferred && <DecisionAnswerForm key={item.id} item={item} onChange={onChange} />}
        </>
      )}

      <div>
        <DecisionDisclosure title={t('contextDetails')}>
          <section aria-label={t('facts')} className="flex flex-col gap-5 text-sm leading-6">
            <p>{item.goal}</p>
            {!awaiting && <p>{item.question}</p>}
            {(!awaiting || lastAnswer) && <p>{item.why}</p>}
            {!awaiting && constraints.map((condition) => <p key={condition}>{condition}</p>)}
            <dl className="flex flex-col gap-4">
              {(item.recommendation || item.recommendationUnavailableReason) && (
                <div>
                  <dt className="font-medium">
                    {t(item.recommendation ? 'recommendationReason' : 'recommendationUnavailable')}
                  </dt>
                  <dd className="text-muted-foreground">
                    {item.recommendation || item.recommendationUnavailableReason}
                  </dd>
                </div>
              )}
              {item.facts.map((fact) => (
                <div key={fact.label}>
                  <dt className="font-medium">{fact.label}</dt>
                  <dd className="text-muted-foreground">{fact.detail}</dd>
                </div>
              ))}
              {item.continuing && (
                <div>
                  <dt className="font-medium">{t('continuingWork')}</dt>
                  <dd className="text-muted-foreground">{item.continuing}</dd>
                </div>
              )}
            </dl>
          </section>
        </DecisionDisclosure>
        <DecisionDisclosure title={t('history')}>
          <section aria-label={t('history')}>
            <p className="mb-4 text-xs text-muted-foreground">
              {item.id.toUpperCase()} · {item.context.agentId}
            </p>
            <ol className="flex flex-col gap-4 border-l pl-4">
              {[...item.events].reverse().map((event) => (
                <li key={event.id} className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{t(`event.${event.kind}`)}</span>
                  {event.text && (
                    <p className="text-sm leading-6 break-words whitespace-pre-wrap text-muted-foreground">
                      {event.text}
                    </p>
                  )}
                  <LocalTime value={event.at} className="text-xs text-muted-foreground" />
                </li>
              ))}
            </ol>
          </section>
        </DecisionDisclosure>
      </div>
    </article>
  );
}
