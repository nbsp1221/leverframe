'use client';

import {
  type ReviewExecutionEvent,
  type ReviewExecutionSnapshot,
  reviewExecutionEventSchema,
  reviewExecutionSnapshotSchema,
} from '@repo/contracts';
import { Spinner } from '@repo/ui/components/spinner';
import { ActivityIcon, TerminalIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useMemo, useState } from 'react';
import { applyExecutionEvent, isTerminalExecution } from './review-execution-state';

type ConnectionState = 'loading' | 'live' | 'reconnecting' | 'closed' | 'error';

type Props = {
  reviewId: number;
  mode: 'live' | 'recent';
};

export function ReviewLiveActivity({ reviewId, mode }: Props) {
  const t = useTranslations('reviewDetail');
  const locale = useLocale();
  const [snapshot, setSnapshot] = useState<ReviewExecutionSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('loading');
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let handleTrace: ((message: MessageEvent) => void) | undefined;
    let handleSnapshot: ((message: MessageEvent) => void) | undefined;

    async function connect() {
      try {
        const response = await fetch(`/api/v1/reviews/${reviewId}/execution`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error('execution snapshot request failed');
        }
        const parsed = reviewExecutionSnapshotSchema.parse(await response.json());
        if (disposed) {
          return;
        }
        setSnapshot(parsed);
        if (isTerminalExecution(parsed.status)) {
          setConnection('closed');
          return;
        }

        source = new EventSource(
          `/api/v1/reviews/${reviewId}/execution/events?after=${parsed.last_sequence}`,
        );
        source.onopen = () => setConnection('live');
        source.onerror = () => {
          if (!disposed) {
            setConnection('reconnecting');
          }
        };
        handleTrace = (message: MessageEvent) => {
          if (disposed || typeof message.data !== 'string') {
            return;
          }
          try {
            const event = reviewExecutionEventSchema.parse(JSON.parse(message.data));
            setSnapshot((current) => (current ? applyExecutionEvent(current, event) : current));
          } catch {
            // Execution trace is best-effort; the durable review remains authoritative.
          }
        };
        handleSnapshot = (message: MessageEvent) => {
          if (disposed || typeof message.data !== 'string') {
            return;
          }
          try {
            const next = reviewExecutionSnapshotSchema.parse(JSON.parse(message.data));
            setSnapshot(next);
            if (isTerminalExecution(next.status)) {
              source?.close();
              setConnection('closed');
            }
          } catch {
            // A later valid snapshot can recover this panel.
          }
        };
        source.addEventListener('trace', handleTrace);
        source.addEventListener('snapshot', handleSnapshot);
      } catch {
        if (!disposed) {
          setConnection('error');
        }
      }
    }

    void connect();
    return () => {
      disposed = true;
      if (handleTrace) {
        source?.removeEventListener('trace', handleTrace);
      }
      if (handleSnapshot) {
        source?.removeEventListener('snapshot', handleSnapshot);
      }
      source?.close();
    };
  }, [reviewId]);

  const events = useMemo(() => {
    const visible = snapshot?.events.filter(isUsefulEvent) ?? [];
    return visible.slice(-8).reverse();
  }, [snapshot]);

  return (
    <section aria-label={mode === 'live' ? t('activityLiveTitle') : t('activityRecentTitle')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-[-0.025em]">
            {mode === 'live' ? t('activityLiveTitle') : t('activityRecentTitle')}
          </h2>
          {snapshot?.last_activity_at ? (
            <p className="mt-1 text-sm text-muted-foreground">
              {t('activityLastUpdate', {
                time: formatRelative(snapshot.last_activity_at, now, locale),
              })}
            </p>
          ) : connection === 'loading' || connection === 'reconnecting' ? (
            <p className="mt-1 text-sm text-muted-foreground">{t('activityLoading')}</p>
          ) : null}
        </div>
        <span
          className="inline-flex items-center gap-2 text-sm font-medium text-muted-foreground"
          aria-live="polite"
        >
          {connection === 'loading' || connection === 'reconnecting' ? (
            <Spinner aria-hidden="true" />
          ) : (
            <ActivityIcon className="size-4" aria-hidden="true" />
          )}
          {t(`traceConnection_${connection}`)}
        </span>
      </div>

      {snapshot?.current_command ? (
        <div className="mt-4 flex min-w-0 items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <Spinner aria-hidden="true" />
          <code className="min-w-0 truncate">{snapshot.current_command.command}</code>
        </div>
      ) : null}

      {!snapshot?.available && snapshot !== null ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('traceUnavailableDescription')}</p>
      ) : null}

      <ol className="mt-4 divide-y divide-border/70 border-y border-border/70">
        {events.length ? (
          events.map((event) => (
            <li key={event.sequence} className="flex min-w-0 gap-3 py-3 text-sm">
              <TerminalIcon
                className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <p className="break-words">{eventLabel(event, t)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {formatRelative(event.observed_at, now, locale)}
                </p>
              </div>
            </li>
          ))
        ) : (
          <li className="py-4 text-sm text-muted-foreground">{t('activityNoEvents')}</li>
        )}
      </ol>
    </section>
  );
}

function isUsefulEvent(event: ReviewExecutionEvent): boolean {
  return [
    'command_started',
    'command_completed',
    'agent_message',
    'tool_activity',
    'turn_failed',
    'file_change',
  ].includes(event.type);
}

function eventLabel(
  event: ReviewExecutionEvent,
  t: ReturnType<typeof useTranslations<'reviewDetail'>>,
): string {
  if (event.command) {
    if (event.type === 'command_started') {
      return t('activityRunningCommand', { command: event.command });
    }
    if (event.type === 'command_completed') {
      return t(event.exit_code === 0 ? 'activityCommandCompleted' : 'activityCommandFailed', {
        command: event.command,
      });
    }
    return event.command;
  }
  if (event.message) {
    return event.message;
  }
  if (event.type === 'file_change') {
    return t('traceEvent_file_change');
  }
  if (event.type === 'tool_activity') {
    return t('traceEvent_tool_activity');
  }
  return event.type;
}

function formatRelative(value: string, now: number, locale: string): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  if (seconds < 60) {
    return formatter.format(-seconds, 'second');
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return formatter.format(-minutes, 'minute');
  }
  return formatter.format(-Math.floor(minutes / 60), 'hour');
}
