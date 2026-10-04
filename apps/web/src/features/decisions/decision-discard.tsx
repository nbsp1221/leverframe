'use client';

import type { Decision } from '@repo/contracts/decisions';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@repo/ui/components/alert-dialog';
import { Button } from '@repo/ui/components/button';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { discardDecision } from './decision-api';

export function DecisionDiscard({
  item,
  onChange,
}: {
  item: Decision;
  onChange: () => Promise<void>;
}) {
  const t = useTranslations('decisions');
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function discard() {
    setBusy(true);
    setError(false);
    try {
      await discardDecision(item.id, item.revision);
      setOpen(false);
      await onChange();
    } catch {
      setError(true);
      await onChange();
    } finally {
      setBusy(false);
    }
  }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(value) => {
        if (!busy) {
          setOpen(value);
          setError(false);
        }
      }}
    >
      <AlertDialogTrigger render={<Button variant="ghost" size="sm" />}>
        {t('discard')}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('discardTitle')}</AlertDialogTitle>
          <AlertDialogDescription>{t('discardHelp')}</AlertDialogDescription>
        </AlertDialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {t('sendError')}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>{t('keepRequest')}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={busy}
            onClick={() => {
              void discard();
            }}
          >
            {t('discard')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
