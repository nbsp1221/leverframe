import type { ComponentProps } from 'react';
import { PageFrame } from '../../components/page-frame';

export function ReviewPageFrame({ className, ...props }: ComponentProps<'div'>) {
  return <PageFrame data-slot="review-page-frame" className={className} {...props} />;
}
