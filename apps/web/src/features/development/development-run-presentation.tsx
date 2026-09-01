'use client';

import type { DevelopmentEvent, DevelopmentRunDetail } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { cn } from '@repo/ui/lib/utils';
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useState } from 'react';

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

export function DevelopmentWorkflowProgress({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  const terminal = detail.run.phase === 'failed' || detail.run.phase === 'cancelled';
  const effectivePhase = terminal ? detail.run.prior_phase : detail.run.phase;
  const currentMilestone = workflowMilestones.findIndex(({ phases }) =>
    phases.some((phase) => phase === effectivePhase),
  );
  const completed = detail.run.phase === 'completed';

  return (
    <section aria-labelledby="workflow-title" className="flex flex-col gap-3 border-y py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="workflow-title" className="font-semibold">
          {t('graph')}
        </h2>
        <span className="text-sm text-muted-foreground">
          {terminal && detail.run.prior_phase !== null
            ? t('workflowStoppedAt', { phase: t(`phase_${detail.run.prior_phase}`) })
            : t(`phase_${detail.run.phase}`)}
        </span>
      </div>
      <ol className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3 lg:grid-cols-6">
        {workflowMilestones.map((milestone, index) => {
          const reached = completed || index <= currentMilestone;
          const current = !completed && !terminal && index === currentMilestone;
          return (
            <li key={milestone.label} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden="true"
                className={cn(
                  'size-2 rounded-full',
                  current && 'bg-primary',
                  !current && reached && 'bg-foreground/40',
                  !current && !reached && 'bg-muted-foreground/20',
                )}
              />
              <span className={current ? 'font-medium' : 'text-muted-foreground'}>
                {t(milestone.label)}
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
    <section aria-labelledby="agent-activity-title" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2 id="agent-activity-title" className="font-semibold">
          {t('conversation')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('conversationDescription')}</p>
      </div>
      {messageEvents.length === 0 ? (
        <p className="border-y py-6 text-sm text-muted-foreground">{t('noAgentMessages')}</p>
      ) : (
        <div className="divide-y border-y">
          {messageEvents.map((event) => (
            <ActivityMessage key={event.sequence} event={event} dateTime={dateTime} />
          ))}
        </div>
      )}
      <LifecycleHistory events={lifecycleEvents} dateTime={dateTime} />
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
  const message = String(event.payload.message);
  const needsDisclosure = message.length > 600 || message.split('\n').length > 8;

  return (
    <article className="flex flex-col gap-2 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline">{event.source}</Badge>
        <span className="text-xs text-muted-foreground">
          {dateTime.format(new Date(event.observed_at))}
        </span>
      </div>
      {needsDisclosure ? (
        <Collapsible open={open} onOpenChange={setOpen}>
          {open ? null : <p className="line-clamp-5 whitespace-pre-wrap text-sm">{message}</p>}
          <CollapsibleContent>
            <p className="whitespace-pre-wrap text-sm">{message}</p>
          </CollapsibleContent>
          <CollapsibleTrigger
            render={<Button type="button" variant="link" className="mt-1 px-0" />}
          >
            {open ? (
              <ChevronUpIcon data-icon="inline-start" />
            ) : (
              <ChevronDownIcon data-icon="inline-start" />
            )}
            {open ? t('showLess') : t('showFullMessage')}
          </CollapsibleTrigger>
        </Collapsible>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{message}</p>
      )}
    </article>
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
        render={<Button type="button" variant="ghost" className="w-full justify-between" />}
      >
        {t('lifecycleHistory', { count: events.length })}
        {open ? (
          <ChevronUpIcon data-icon="inline-end" />
        ) : (
          <ChevronDownIcon data-icon="inline-end" />
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
              <span className="text-xs text-muted-foreground">
                {dateTime.format(new Date(event.observed_at))}
              </span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
