'use client';

import { useLocale } from 'next-intl';
import { useSyncExternalStore } from 'react';

const subscribe = () => () => undefined;

export function LocalTime({ value, className }: { value: string; className?: string }) {
  const locale = useLocale();
  const mounted = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  const formatted = mounted
    ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value),
      )
    : '—';

  return (
    <time className={className} dateTime={value} title={value}>
      {formatted}
    </time>
  );
}
