import type { ComponentProps } from 'react';
import { cn } from '@repo/ui/lib/utils';

export function ReviewPageFrame({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="review-page-frame"
      className={cn('mx-auto w-full max-w-[2160px]', className)}
      {...props}
    />
  );
}
