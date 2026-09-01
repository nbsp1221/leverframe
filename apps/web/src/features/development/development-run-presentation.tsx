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
import { type ReactNode, useId, useState } from 'react';
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
    <section className="flex flex-col gap-1.5 px-2 py-2.5" aria-labelledby={titleId}>
      <h2 id={titleId} className="px-2 text-xs font-medium text-muted-foreground">
        {t('graph')}
      </h2>
      <ol className="flex flex-col gap-0.5">
        {workflowMilestones.map((milestone, index) => {
          const reached = completed || index < currentMilestone;
          const current = !completed && index === currentMilestone;
          const stopped = terminal && current;
          const Icon = stopped ? CircleStopIcon : reached || completed ? CheckIcon : CircleIcon;
          return (
            <li
              key={milestone.label}
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm text-muted-foreground',
                current && 'bg-muted font-medium text-foreground',
              )}
            >
              <Icon aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{t(milestone.label)}</span>
              {stopped ? <span className="ml-auto text-xs">{t('stopped')}</span> : null}
              {!terminal && current ? (
                <span className="ml-auto text-xs">{t('current')}</span>
              ) : null}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function DevelopmentActivity({
  events,
  children,
}: {
  events: DevelopmentEvent[];
  children?: ReactNode;
}) {
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
    <section
      aria-labelledby="agent-activity-title"
      className="min-w-0 lg:h-[calc(100svh-9rem)] lg:min-h-[32rem]"
    >
      <h1 id="agent-activity-title" className="sr-only">
        {t('conversation')}
      </h1>
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
              {children === undefined || children === null ? null : (
                <MessageScrollerItem messageId="interrupt" scrollAnchor>
                  <Message>
                    <MessageContent>{children}</MessageContent>
                  </Message>
                </MessageScrollerItem>
              )}
              <MessageScrollerItem messageId="lifecycle">
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
    <Message>
      <MessageContent>
        <MessageHeader className="gap-2 px-0">
          <span>{t(`source_${event.source}`)}</span>
        </MessageHeader>
        {needsDisclosure ? (
          <Collapsible open={open} onOpenChange={setOpen}>
            {open ? null : (
              <p className="line-clamp-5 whitespace-pre-wrap text-sm leading-6">{message}</p>
            )}
            <CollapsibleContent>
              <p className="whitespace-pre-wrap text-sm leading-6">{message}</p>
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
          <p className="whitespace-pre-wrap text-sm leading-6">{message}</p>
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
