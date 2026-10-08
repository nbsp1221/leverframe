import type { ReactNode } from 'react';
import { cn } from '@repo/ui/lib/utils';

export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: string;
  description: string;
  actions?: ReactNode;
  className?: string | undefined;
}) {
  return (
    <header className={cn('flex flex-wrap items-start justify-between gap-4 px-0.5', className)}>
      <div className="min-w-0">
        <h1 className="text-3xl font-bold tracking-[-0.045em]">{title}</h1>
        <p className="mt-1.5 max-w-2xl text-sm leading-6 text-muted-foreground">{description}</p>
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}
