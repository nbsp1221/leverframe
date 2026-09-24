import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';

export function PageMetric({
  label,
  value,
  description,
  tone = 'default',
  last = false,
}: {
  label: string;
  value: ReactNode;
  description?: ReactNode;
  tone?: 'default' | 'info';
  last?: boolean;
}) {
  return (
    <div
      className={cn(
        'min-w-0 px-5 py-5 sm:flex sm:min-h-36 sm:flex-col sm:justify-center sm:py-6',
        !last && 'border-b border-border/75 sm:border-r sm:border-b-0',
        tone === 'info' && 'text-info',
      )}
    >
      <p className="text-xs font-semibold text-muted-foreground sm:truncate">{label}</p>
      <p className="mt-1.5 text-xl font-bold tracking-[-0.025em] tabular-nums sm:truncate">
        {value}
      </p>
      {description ? (
        <div className="mt-1 text-xs text-muted-foreground sm:truncate">{description}</div>
      ) : null}
    </div>
  );
}
