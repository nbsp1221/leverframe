import type { ComponentProps } from 'react';
import { cn } from '@repo/ui/lib/utils';

export function PageSurface({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-2xl border border-border/75 bg-surface shadow-sm shadow-foreground/[0.025]',
        className,
      )}
      {...props}
    />
  );
}
