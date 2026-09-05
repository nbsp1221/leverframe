'use client';

import {
  type ReviewExecutionEvent,
  type ReviewExecutionSnapshot,
  reviewExecutionEventSchema,
  reviewExecutionSnapshotSchema,
} from '@repo/contracts';
import { Spinner } from '@repo/ui/components/spinner';
import { ActivityIcon, TerminalIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { applyExecutionEvent, isTerminalExecution } from './review-execution-state';

type Props = {
  reviewId: number;
  mode: 'live' | 'recent';
};

type Connection = 'loading' | 'live' | 'closed' | 'reconnecting' | 'error';

export function ReviewDetailPrototypeActivity({ reviewId, mode }: Props) {
  const [snapshot, setSnapshot] = useState<ReviewExecutionSnapshot | null>(null);
  const [connection, setConnection] = useState<Connection>('loading');
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
          throw new Error('snapshot request failed');
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
            // Prototype QA surface: ignore malformed best-effort trace events.
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
            // A later snapshot can recover this prototype view.
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
    return visible.slice(-6).reverse();
  }, [snapshot]);

  return (
    <section aria-label="Live activity" className="min-w-0">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">
            {mode === 'live' ? '실시간 활동' : '마지막 활동'}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {snapshot?.last_activity_at
              ? `마지막 업데이트 ${relative(snapshot.last_activity_at, now)}`
              : '활동 정보를 불러오는 중'}
          </p>
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
          {connectionLabel(connection)}
        </span>
      </div>

      {snapshot?.current_command ? (
        <div className="mt-4 flex min-w-0 items-center gap-3 rounded-xl bg-muted/60 px-4 py-3 text-sm">
          <Spinner aria-hidden="true" />
          <code className="min-w-0 truncate">{snapshot.current_command.command}</code>
        </div>
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
                <p className="break-words">{eventLabel(event)}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {relative(event.observed_at, now)}
                </p>
              </div>
            </li>
          ))
        ) : (
          <li className="py-4 text-sm text-muted-foreground">아직 표시할 활동이 없습니다.</li>
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

function eventLabel(event: ReviewExecutionEvent): string {
  if (event.command) {
    if (event.type === 'command_started') {
      return `실행 중 · ${event.command}`;
    }
    if (event.type === 'command_completed') {
      return `${event.exit_code === 0 ? '완료' : '실패'} · ${event.command}`;
    }
    return event.command;
  }
  if (event.message) {
    return event.message;
  }
  if (event.type === 'file_change') {
    return '파일 변경을 확인했습니다.';
  }
  if (event.type === 'tool_activity') {
    return '도구를 사용하고 있습니다.';
  }
  return event.type;
}

function relative(value: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(value)) / 1000));
  if (seconds < 5) {
    return '방금';
  }
  if (seconds < 60) {
    return `${seconds}초 전`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}분 전`;
  }
  return `${Math.floor(minutes / 60)}시간 전`;
}

function connectionLabel(connection: Connection): string {
  if (connection === 'live') {
    return '연결됨';
  }
  if (connection === 'reconnecting') {
    return '재연결 중';
  }
  if (connection === 'error') {
    return '연결 확인 필요';
  }
  if (connection === 'closed') {
    return '실행 종료';
  }
  return '연결 중';
}
