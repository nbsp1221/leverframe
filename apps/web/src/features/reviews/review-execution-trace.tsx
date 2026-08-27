'use client';

import {
  type ReviewExecutionEvent,
  type ReviewExecutionSnapshot,
  reviewExecutionEventSchema,
  reviewExecutionSnapshotSchema,
} from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/card';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Spinner } from '@repo/ui/components/spinner';
import { ActivityIcon, ChevronDownIcon, TerminalIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import {
  applyExecutionEvent,
  isTerminalExecution,
  shouldRefreshForTerminalSnapshot,
} from './review-execution-state';

type ConnectionState = 'loading' | 'live' | 'reconnecting' | 'closed' | 'error';
type Translator = ReturnType<typeof useTranslations>;

export function ReviewExecutionTrace({ reviewId }: { reviewId: number }) {
  const t = useTranslations('reviewDetail');
  const router = useRouter();
  const [snapshot, setSnapshot] = useState<ReviewExecutionSnapshot | null>(null);
  const [connection, setConnection] = useState<ConnectionState>('loading');
  const [now, setNow] = useState(() => Date.now());
  const refreshedRef = useRef(false);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    let disposed = false;
    let source: EventSource | undefined;
    let handleTrace: ((message: MessageEvent) => void) | undefined;
    let handleSnapshot: ((message: MessageEvent) => void) | undefined;

    function refreshForTerminalSnapshot(status: ReviewExecutionSnapshot['status']) {
      if (shouldRefreshForTerminalSnapshot(status, refreshedRef.current)) {
        refreshedRef.current = true;
        router.refresh();
      }
    }

    async function connect() {
      try {
        const response = await fetch(`/api/v1/reviews/${reviewId}/execution`, {
          cache: 'no-store',
        });
        if (!response.ok) {
          throw new Error('execution snapshot request failed');
        }
        const parsed = reviewExecutionSnapshotSchema.safeParse(await response.json());
        if (!parsed.success || disposed) {
          throw new Error('invalid execution snapshot');
        }
        setSnapshot(parsed.data);
        if (isTerminalExecution(parsed.data.status)) {
          setConnection('closed');
          refreshForTerminalSnapshot(parsed.data.status);
          return;
        }
        source = new EventSource(
          `/api/v1/reviews/${reviewId}/execution/events?after=${parsed.data.last_sequence}`,
        );
        source.onopen = () => setConnection('live');
        source.onerror = () => {
          if (!disposed) {
            setConnection('reconnecting');
          }
        };
        handleTrace = (message: MessageEvent) => {
          try {
            if (typeof message.data !== 'string') {
              return;
            }
            const event = reviewExecutionEventSchema.parse(JSON.parse(message.data));
            setSnapshot((current) =>
              current === null ? current : applyExecutionEvent(current, event),
            );
          } catch {
            // Ignore malformed diagnostic events; the durable review remains authoritative.
          }
        };
        handleSnapshot = (message: MessageEvent) => {
          try {
            if (typeof message.data !== 'string') {
              return;
            }
            const next = reviewExecutionSnapshotSchema.parse(JSON.parse(message.data));
            setSnapshot((current) => mergeSnapshot(current, next));
            if (isTerminalExecution(next.status)) {
              source?.close();
              setConnection('closed');
              refreshForTerminalSnapshot(next.status);
            }
          } catch {
            // A later valid snapshot or route refresh can recover this best-effort panel.
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
  }, [reviewId, router]);

  const visibleEvents = snapshot?.events.filter(visibleEvent) ?? [];
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle>{t('liveTrace')}</CardTitle>
            <CardDescription>{t('liveTraceDescription')}</CardDescription>
          </div>
          <Badge variant="outline" aria-live="polite">
            {connection === 'loading' || connection === 'reconnecting' ? (
              <Spinner data-icon="inline-start" aria-hidden="true" />
            ) : (
              <ActivityIcon aria-hidden="true" />
            )}
            {t(`traceConnection_${connection}`)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {snapshot === null ? (
          <p className="text-sm text-muted-foreground">{t('traceLoading')}</p>
        ) : (
          <>
            <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
              <TraceFact label={t('status')} value={t(snapshot.status)} />
              <TraceFact label={t('attempt')} value={`#${snapshot.attempt}`} />
              <TraceFact label={t('stage')} value={t(`traceStage_${snapshot.stage}`)} />
              <TraceFact label={t('elapsed')} value={elapsed(snapshot.started_at, now) ?? '—'} />
              <TraceFact
                label={t('processHeartbeat')}
                value={relative(snapshot.process_heartbeat_at, now, t)}
              />
              <TraceFact
                label={t('lastCodexActivity')}
                value={relative(snapshot.last_activity_at, now, t)}
              />
            </div>
            {!snapshot.available ? (
              <Alert>
                <AlertTitle>{t('traceUnavailable')}</AlertTitle>
                <AlertDescription>{t('traceUnavailableDescription')}</AlertDescription>
              </Alert>
            ) : null}
            {snapshot.current_command ? (
              <section className="rounded-md border border-border bg-muted/40 p-4">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <Spinner aria-hidden="true" />
                  {t('currentCommand')}
                </div>
                <code className="mt-2 block break-all text-xs leading-5">
                  {snapshot.current_command.command}
                </code>
                <p className="mt-2 text-xs text-muted-foreground">
                  {t('runningFor')} {elapsed(snapshot.current_command.started_at, now) ?? '—'}
                </p>
              </section>
            ) : null}
            {snapshot.trace_truncated ? (
              <Alert>
                <AlertTitle>{t('traceTruncated')}</AlertTitle>
                <AlertDescription>{t('traceTruncatedDescription')}</AlertDescription>
              </Alert>
            ) : null}
            <section>
              <h3 className="text-sm font-medium">{t('activityTimeline')}</h3>
              {visibleEvents.length === 0 ? (
                <p className="mt-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
                  {t('noTraceActivity')}
                </p>
              ) : (
                <ol className="mt-3 space-y-3">
                  {visibleEvents.map((event) => (
                    <TraceEvent key={event.sequence} event={event} t={t} />
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function TraceFact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-medium">{value}</p>
    </div>
  );
}

function TraceEvent({ event, t }: { event: ReviewExecutionEvent; t: Translator }) {
  const title = eventTitle(event, t);
  return (
    <li className="rounded-md border border-border p-3 text-sm">
      <div className="flex min-w-0 items-start gap-3">
        <TerminalIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <p className="break-words font-medium">{title}</p>
              <Badge variant="outline">#{event.attempt}</Badge>
            </div>
            <time className="text-xs text-muted-foreground">{formatTime(event.observed_at)}</time>
          </div>
          {event.command ? (
            <code className="mt-2 block break-all text-xs leading-5">{event.command}</code>
          ) : null}
          {event.message ? (
            <p className="mt-2 whitespace-pre-wrap break-words text-sm text-muted-foreground">
              {event.message}
            </p>
          ) : null}
          {event.output !== null ? (
            <Collapsible className="mt-3">
              <CollapsibleTrigger className="flex w-full items-center justify-between rounded-md border border-border px-3 py-2 text-left text-xs hover:bg-muted">
                <span>
                  {t('commandOutput')}
                  {event.output_truncated ? ` · ${t('outputTruncated')}` : ''}
                </span>
                <ChevronDownIcon aria-hidden="true" className="size-4" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <pre className="mt-2 max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 text-xs">
                  {event.output || t('emptyOutput')}
                </pre>
              </CollapsibleContent>
            </Collapsible>
          ) : null}
        </div>
      </div>
    </li>
  );
}

function eventTitle(event: ReviewExecutionEvent, t: Translator): string {
  if (event.type === 'command_completed') {
    const result = event.exit_code === null ? event.status : `${t('exitCode')} ${event.exit_code}`;
    const duration = event.duration_ms === null ? '' : ` · ${formatDuration(event.duration_ms)}`;
    return `${t('commandCompleted')} · ${result ?? t('unknown')}${duration}`;
  }
  return t(`traceEvent_${event.type}`);
}

function mergeSnapshot(
  current: ReviewExecutionSnapshot | null,
  incoming: ReviewExecutionSnapshot,
): ReviewExecutionSnapshot {
  if (current === null) {
    return incoming;
  }
  return { ...incoming, events: incoming.events.length === 0 ? current.events : incoming.events };
}

function visibleEvent(event: ReviewExecutionEvent): boolean {
  return [
    'sandbox_environment',
    'command_completed',
    'agent_message',
    'file_change',
    'tool_activity',
    'turn_failed',
    'trace_notice',
  ].includes(event.type);
}

function relative(value: string | null, now: number, t: Translator): string {
  if (value === null) {
    return '—';
  }
  return t('timeAgo', { duration: formatDuration(Math.max(0, now - Date.parse(value))) });
}

function elapsed(value: string | null, now: number): string | null {
  return value === null ? null : formatDuration(Math.max(0, now - Date.parse(value)));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date(value));
}
