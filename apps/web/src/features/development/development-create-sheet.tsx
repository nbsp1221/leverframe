'use client';

import type { DevelopmentRepository, DevelopmentTicket } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet';
import { PlusIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { DevelopmentCreateForm } from './development-create-form';

export function DevelopmentCreateSheet({
  repositories,
  tickets,
}: {
  repositories: DevelopmentRepository[];
  tickets: DevelopmentTicket[] | null;
}) {
  const t = useTranslations('development');

  return (
    <Sheet>
      <SheetTrigger render={<Button />}>
        <PlusIcon data-icon="inline-start" />
        {t('newDevelopment')}
      </SheetTrigger>
      <SheetContent className="w-full data-[side=right]:sm:max-w-2xl">
        <SheetHeader className="border-b pr-12">
          <SheetTitle>{t('newDevelopment')}</SheetTitle>
          <SheetDescription>{t('newRunDescription')}</SheetDescription>
        </SheetHeader>
        <DevelopmentCreateForm repositories={repositories} tickets={tickets} />
      </SheetContent>
    </Sheet>
  );
}
