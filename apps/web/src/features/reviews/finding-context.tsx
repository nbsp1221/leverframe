'use client';

import { contextResponseSchema } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Skeleton } from '@repo/ui/components/skeleton';
import { useTranslations } from 'next-intl';
import { createContext, use, useState } from 'react';

export type ContextTransport = typeof fetch;

const ContextTransportContext = createContext<ContextTransport>(fetch);

export function useContextTransport() {
  return use(ContextTransportContext);
}

export function ContextTransportProvider({
  transport,
  children,
}: {
  transport: ContextTransport;
  children: React.ReactNode;
}) {
  return <ContextTransportContext value={transport}>{children}</ContextTransportContext>;
}

type Props = { reviewId: number; fingerprint: string; embedded?: boolean };

export function FindingContext({ reviewId, fingerprint, embedded = false }: Props) {
  const t = useTranslations('reviewDetail');
  const transport = useContextTransport();
  const [state, setState] = useState<'idle' | 'loading' | 'available' | 'unavailable' | 'error'>(
    'idle',
  );
  const [context, setContext] = useState<ReturnType<typeof contextResponseSchema.parse> | null>(
    null,
  );

  async function load() {
    setState('loading');
    try {
      const response = await transport(
        `/api/v1/reviews/${reviewId}/findings/${fingerprint}/context`,
        { cache: 'no-store' },
      );
      if (!response.ok) {
        setState('error');
        return;
      }
      const parsed = contextResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        setState('error');
        return;
      }
      setContext(parsed.data);
      setState(parsed.data.available ? 'available' : 'unavailable');
    } catch {
      setState('error');
    }
  }

  return (
    <section
      className={
        embedded
          ? 'flex flex-col gap-3'
          : 'flex flex-col gap-3 rounded-xl border border-border/70 bg-surface p-4'
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium">{t('codeContext')}</p>
        {state === 'idle' || state === 'error' ? (
          <Button type="button" size="sm" variant="outline" onClick={() => void load()}>
            {t(state === 'error' ? 'retryContext' : 'loadContext')}
          </Button>
        ) : null}
      </div>
      {state === 'loading' ? (
        <Skeleton
          className="h-24 w-full"
          role="status"
          aria-live="polite"
          aria-label={t('contextLoading')}
        />
      ) : null}
      {state === 'available' && context ? (
        <div className="flex flex-col gap-2 text-xs">
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline">
              {t(context.source === 'stored_evidence' ? 'storedEvidence' : 'githubComparison')}
            </Badge>
            <span className="text-muted-foreground">
              {context.file}:{context.start_line ?? context.line}–{context.end_line ?? context.line}
            </span>
          </div>
          <pre className="max-h-96 max-w-full overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3">
            {(context.content ?? '').slice(0, 16_384)}
          </pre>
        </div>
      ) : null}
      {state === 'unavailable' ? (
        <Alert>
          <AlertTitle>{t('contextUnavailable')}</AlertTitle>
          <AlertDescription>{t('contextUnavailableDescription')}</AlertDescription>
        </Alert>
      ) : null}
      {state === 'error' ? (
        <Alert variant="destructive">
          <AlertTitle>{t('contextError')}</AlertTitle>
          <AlertDescription>{t('contextErrorDescription')}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
