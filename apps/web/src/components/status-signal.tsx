import type { ComponentProps } from 'react';
import { cn } from '@repo/ui/lib/utils';

export function StatusSignal({
  tone = 'muted',
  className,
  children,
  ...props
}: ComponentProps<'span'> & { tone?: 'success' | 'info' | 'warning' | 'danger' | 'muted' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 text-xs font-semibold',
        tone === 'success' && 'text-success',
        tone === 'info' && 'text-info',
        tone === 'warning' && 'text-warning',
        tone === 'danger' && 'text-danger',
        tone === 'muted' && 'text-muted-foreground',
        className,
      )}
      {...props}
    >
      <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
      {children}
    </span>
  );
}
