'use client';

import type { DevelopmentEvent, DevelopmentRunDetail } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Message, MessageContent, MessageFooter, MessageHeader } from '@repo/ui/components/message';
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@repo/ui/components/message-scroller';
import { cn } from '@repo/ui/lib/utils';
import {
  ArrowDownIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  CircleIcon,
  CircleStopIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import { StatusSignal } from '../../components/status-signal';
import { DevelopmentMarkdown } from './development-markdown';
import { normalizeWorkspacePaths } from './development-message';

const workflowMilestones = [
  {
    label: 'workflowPlan',
    phases: ['intake', 'preparing', 'planning', 'waiting_for_input', 'awaiting_plan_approval'],
  },
  { label: 'workflowImplement', phases: ['implementing'] },
  { label: 'workflowVerify', phases: ['verifying'] },
  { label: 'workflowPublish', phases: ['awaiting_publication_approval', 'publishing'] },
  { label: 'workflowReview', phases: ['reviewing'] },
  { label: 'workflowMerge', phases: ['awaiting_merge', 'completed'] },
] as const;

export function DevelopmentWorkflowOverview({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  const titleId = useId();
  const terminal = detail.run.phase === 'failed' || detail.run.phase === 'cancelled';
  const effectivePhase = terminal ? detail.run.prior_phase : detail.run.phase;
  const currentMilestone = workflowMilestones.findIndex(({ phases }) =>
    phases.some((phase) => phase === effectivePhase),
  );
  const completed = detail.run.phase === 'completed';

  return (
    <section className="shrink-0 py-5" aria-labelledby={titleId}>
      <div className="mb-4 flex items-center justify-between gap-4">
        <div>
          <h2 id={titleId} className="text-xl font-bold tracking-[-0.025em]">
            {t('graph')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('graphDescription')}</p>
        </div>
        <StatusSignal
          tone={
            detail.run.operator_action !== null
              ? 'warning'
              : detail.run.phase === 'failed'
                ? 'danger'
                : detail.run.phase === 'cancelled'
                  ? 'muted'
                  : completed
                    ? 'success'
                    : 'info'
          }
          className="shrink-0"
        >
          {t(`phase_${detail.run.phase}`)}
        </StatusSignal>
      </div>
      <ol className="grid gap-2 md:grid-cols-6 md:gap-0">
        {workflowMilestones.map((milestone, index) => {
          const reached = completed || index < currentMilestone;
          const current = !completed && index === currentMilestone;
          const stopped = terminal && current;
          const Icon = stopped ? CircleStopIcon : reached || completed ? CheckIcon : CircleIcon;
          return (
            <li
              key={milestone.label}
              className="relative flex min-w-0 items-center gap-3 md:flex-col md:gap-2 md:text-center"
              aria-current={current ? 'step' : undefined}
            >
              {index === 0 ? null : (
                <span
                  aria-hidden="true"
                  className={cn(
                    'absolute -top-2 left-3 h-2 w-px bg-border md:top-3 md:right-1/2 md:left-auto md:h-px md:w-full',
                    (reached || current) && 'bg-primary',
                  )}
                />
              )}
              <span
                className={cn(
                  'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border bg-background text-muted-foreground',
                  (reached || completed) && 'border-primary bg-primary text-primary-foreground',
                  current && 'border-primary text-primary',
                  stopped && 'border-destructive text-destructive',
                )}
              >
                <Icon
                  aria-hidden="true"
                  className={cn('size-3.5', current && !stopped && 'fill-current')}
                />
              </span>
              <span className="flex min-w-0 items-baseline gap-2 md:flex-col md:items-center md:gap-0.5">
                <span
                  className={cn(
                    'truncate text-sm text-muted-foreground',
                    (current || completed) && 'font-medium text-foreground',
                  )}
                >
                  {t(milestone.label)}
                </span>
                {stopped ? <span className="text-xs text-destructive">{t('stopped')}</span> : null}
                {!terminal && current ? (
                  <span className="text-xs text-primary">{t('current')}</span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function DevelopmentActivity({ events }: { events: DevelopmentEvent[] }) {
  const t = useTranslations('development');
  const locale = useLocale();
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });
  const messageEvents = events.filter(
    (event) => typeof event.payload.message === 'string' && event.payload.message.trim() !== '',
  );
  const lifecycleEvents = events.filter(
    (event) => typeof event.payload.message !== 'string' || event.payload.message.trim() === '',
  );

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="mb-4 shrink-0">
        <h2 id="agent-activity-title" className="text-xl font-bold tracking-[-0.025em]">
          {t('agentActivity')}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('agentActivityDescription')}</p>
      </div>
      <MessageScrollerProvider defaultScrollPosition="end">
        <MessageScroller>
          <MessageScrollerViewport aria-label={t('conversation')}>
            <MessageScrollerContent className="gap-6 pb-4">
              {messageEvents.length === 0 ? (
                <MessageScrollerItem messageId="empty">
                  <p className="py-6 text-sm text-muted-foreground">{t('noAgentMessages')}</p>
                </MessageScrollerItem>
              ) : (
                messageEvents.map((event) => (
                  <MessageScrollerItem key={event.sequence} messageId={`event-${event.sequence}`}>
                    <ActivityMessage event={event} dateTime={dateTime} />
                  </MessageScrollerItem>
                ))
              )}
              <MessageScrollerItem messageId="lifecycle" scrollAnchor>
                <LifecycleHistory events={lifecycleEvents} dateTime={dateTime} />
              </MessageScrollerItem>
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton>
            <ArrowDownIcon aria-hidden="true" />
            <span className="sr-only">{t('scrollLatest')}</span>
          </MessageScrollerButton>
        </MessageScroller>
      </MessageScrollerProvider>
    </section>
  );
}

function ActivityMessage({
  event,
  dateTime,
}: {
  event: DevelopmentEvent;
  dateTime: Intl.DateTimeFormat;
}) {
  const t = useTranslations('development');
  const [open, setOpen] = useState(false);
  const message = normalizeWorkspacePaths(String(event.payload.message));
  const needsDisclosure = message.length > 600 || message.split('\n').length > 8;

  return (
    <Message className="border-b border-border/70 pb-5 last:border-b-0">
      <MessageContent>
        <MessageHeader className="gap-2 px-0">
          <span>{t(`source_${event.source}`)}</span>
        </MessageHeader>
        {needsDisclosure ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            {open ? null : (
              <div className="line-clamp-5">
                <DevelopmentMarkdown>{message}</DevelopmentMarkdown>
              </div>
            )}
            <CollapsibleContent>
              <DevelopmentMarkdown>{message}</DevelopmentMarkdown>
            </CollapsibleContent>
            <CollapsibleTrigger
              render={<Button type="button" variant="link" size="sm" className="mt-1 px-0" />}
            >
              {open ? (
                <ChevronUpIcon data-icon="inline-start" aria-hidden="true" />
              ) : (
                <ChevronDownIcon data-icon="inline-start" aria-hidden="true" />
              )}
              {open ? t('showLess') : t('showFullMessage')}
            </CollapsibleTrigger>
          </Collapsible>
        ) : (
          <DevelopmentMarkdown>{message}</DevelopmentMarkdown>
        )}
        <MessageFooter className="px-0">
          <time dateTime={event.observed_at}>{dateTime.format(new Date(event.observed_at))}</time>
        </MessageFooter>
      </MessageContent>
    </Message>
  );
}

function LifecycleHistory({
  events,
  dateTime,
}: {
  events: DevelopmentEvent[];
  dateTime: Intl.DateTimeFormat;
}) {
  const t = useTranslations('development');
  const [open, setOpen] = useState(false);
  if (events.length === 0) {
    return null;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        render={
          <Button type="button" variant="ghost" size="sm" className="w-full justify-between" />
        }
      >
        {t('lifecycleHistory', { count: events.length })}
        {open ? (
          <ChevronUpIcon data-icon="inline-end" aria-hidden="true" />
        ) : (
          <ChevronDownIcon data-icon="inline-end" aria-hidden="true" />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-2 flex flex-col gap-2 border-l pl-4">
          {events.map((event) => (
            <li
              key={event.sequence}
              className="flex flex-wrap items-baseline justify-between gap-2 text-sm"
            >
              <span>{event.type.replaceAll('_', ' ')}</span>
              <time className="text-xs text-muted-foreground" dateTime={event.observed_at}>
                {dateTime.format(new Date(event.observed_at))}
              </time>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
