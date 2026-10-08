'use client';
import type { Connector } from '@repo/contracts/connectors';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button, buttonVariants } from '@repo/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@repo/ui/components/empty';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
import { Skeleton } from '@repo/ui/components/skeleton';
import { Textarea } from '@repo/ui/components/textarea';
import {
  ArrowRightIcon,
  CheckIcon,
  CopyIcon,
  MonitorIcon,
  PlusIcon,
  RefreshCwIcon,
} from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalTime } from '../../components/local-time';
import { PageFrame } from '../../components/page-frame';
import { PageHeader } from '../../components/page-header';
import { PageSurface } from '../../components/page-surface';
import { Link } from '../../i18n/navigation';
import { createPairing, loadConnectors, loadPairing, revokeConnector } from './connector-api';

function CopyText({ text, label }: { text: string; label: string }) {
  const t = useTranslations('connectors');
  const ref = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState(false);
  const [manual, setManual] = useState(false);
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Textarea
        ref={ref}
        aria-label={label}
        value={text}
        readOnly
        className="min-h-24 font-mono text-xs"
        onFocus={(event) => event.target.select()}
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void (async () => {
              try {
                await navigator.clipboard.writeText(text);
                setCopied(true);
              } catch {
                ref.current?.focus();
                ref.current?.select();
                setManual(true);
              }
            })();
          }}
        >
          {copied ? <CheckIcon data-icon="inline-start" /> : <CopyIcon data-icon="inline-start" />}
          {copied ? t('copied') : t('copy')}
        </Button>
        {manual && <FieldDescription>{t('copyManually')}</FieldDescription>}
      </div>
    </Field>
  );
}

export function ConnectorWorkspace() {
  const t = useTranslations('connectors');
  const locale = useLocale();
  const [items, setItems] = useState<Connector[] | null>(null);
  const [error, setError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pending, setPending] = useState(false);
  const [pair, setPair] = useState<{ id: string; code: string; expiresAt: string } | null>(null);
  const [pairStatus, setPairStatus] = useState<'waiting' | 'connected' | 'expired'>('waiting');
  const [command, setCommand] = useState('');
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [checkingId, setCheckingId] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setItems(await loadConnectors());
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, 2500);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    if (!pair || pairStatus !== 'waiting') {
      return;
    }
    const timer = setInterval(() => {
      void loadPairing(pair.id)
        .then((value) => setPairStatus(value.status))
        .catch(() => setError(true));
    }, 1500);
    return () => clearInterval(timer);
  }, [pair, pairStatus]);

  const connect = async () => {
    setPending(true);
    try {
      const next = await createPairing();
      setPair(next);
      setPairStatus('waiting');

      const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

      const origin = window.location.origin;
      setCommand(
        `curl -fsS ${quote(`${origin}/api/v1/connectors/download/install.sh`)} | sh -s -- ${quote(origin)} ${quote(next.code)} ${quote(locale)}`,
      );
      setError(false);
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  };

  const active = items?.filter((item) => item.status !== 'revoked') ?? [];
  return (
    <PageFrame className="flex flex-col gap-6">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <Button
            disabled={pending}
            onClick={() => {
              void connect();
            }}
          >
            <PlusIcon data-icon="inline-start" />
            {t('add')}
          </Button>
        }
      />
      {(error || loadError) && (
        <Alert variant="destructive">
          <AlertTitle>{t('error')}</AlertTitle>
          <AlertDescription>
            {t('errorHelp')}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {pair && (
        <PageSurface className="p-6 sm:p-8">
          <div className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 className="text-xl font-semibold">
                {t(pairStatus === 'connected' ? 'connectedTitle' : 'setupTitle')}
              </h2>
              <Badge variant={pairStatus === 'expired' ? 'destructive' : 'secondary'}>
                {t(`pair.${pairStatus}`)}
              </Badge>
            </div>
            {pairStatus === 'waiting' && (
              <>
                <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
                  {t('setupDescription')}
                </p>
                <CopyText text={command} label={t('installCommand')} />
                <p className="text-xs leading-6 text-muted-foreground">
                  {t('expires')} <LocalTime value={pair.expiresAt} />
                  <br />
                  {t('requirements')}
                </p>
              </>
            )}
            {pairStatus === 'expired' && (
              <>
                <p className="text-sm text-muted-foreground">{t('expiredHelp')}</p>
                <Button
                  disabled={pending}
                  onClick={() => {
                    void connect();
                  }}
                >
                  {t('newCode')}
                </Button>
              </>
            )}
            {pairStatus === 'connected' && (
              <>
                <p className="text-sm text-muted-foreground">{t('connectedHelp')}</p>
                <Button variant="outline" onClick={() => setPair(null)}>
                  {t('closeSetup')}
                </Button>
              </>
            )}
          </div>
        </PageSurface>
      )}
      {items === null && !error && <Skeleton className="h-56 w-full" />}
      {items && active.length === 0 && !pair && (
        <PageSurface>
          <Empty className="py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MonitorIcon />
              </EmptyMedia>
              <EmptyTitle>{t('emptyTitle')}</EmptyTitle>
              <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
            </EmptyHeader>
            <Button
              disabled={pending}
              onClick={() => {
                void connect();
              }}
            >
              {t('add')}
            </Button>
          </Empty>
        </PageSurface>
      )}
      {active.length > 0 && (
        <PageSurface className="divide-y divide-border">
          {active.map((item) => (
            <section
              key={item.id}
              aria-label={item.name}
              className="flex flex-col gap-6 p-6 sm:p-8"
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex items-start gap-4">
                  <MonitorIcon aria-hidden="true" className="mt-1 size-6 text-muted-foreground" />
                  <div className="flex flex-col gap-1">
                    <h2 className="text-xl font-semibold">{item.name}</h2>
                    <p className="text-xs text-muted-foreground">{item.hostname} · Codex</p>
                  </div>
                </div>
                <Badge variant={item.status === 'online' ? 'secondary' : 'outline'}>
                  {t(`status.${item.status}`)}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">{t('scope')}</p>
              <dl className="grid gap-6 sm:grid-cols-3">
                <div className="flex flex-col gap-2">
                  <dt className="text-xs text-muted-foreground">{t('agent')}</dt>
                  <dd className="text-sm font-medium">
                    {t(
                      item.status === 'offline'
                        ? 'agentUnknown'
                        : item.health.codex === 'ready'
                          ? 'agentReady'
                          : 'agentMissing',
                    )}
                  </dd>
                </div>
                <div className="flex flex-col gap-2">
                  <dt className="text-xs text-muted-foreground">{t('skill')}</dt>
                  <dd className="text-sm font-medium">
                    {t(item.health.skill === 'installed' ? 'skillInstalled' : 'skillMissing')}
                  </dd>
                </div>
                <div className="flex flex-col gap-2">
                  <dt className="text-xs text-muted-foreground">{t('roundtrip')}</dt>
                  <dd className="text-sm font-medium">
                    {t(
                      item.lastDeliveredAt
                        ? 'roundtripDone'
                        : item.lastQuestionAt
                          ? 'questionReceived'
                          : 'notTested',
                    )}
                  </dd>
                </div>
              </dl>
              {item.status === 'offline' && (
                <Alert>
                  <AlertTitle>{t('offlineTitle')}</AlertTitle>
                  <AlertDescription>
                    {t('offlineHelp')}
                    <code className="break-all">
                      node ~/.local/share/leverframe-connector/bin/connector.js start
                    </code>
                  </AlertDescription>
                </Alert>
              )}
              {item.status === 'online' && item.health.codex === 'unavailable' && (
                <Alert>
                  <AlertTitle>{t('codexMissingTitle')}</AlertTitle>
                  <AlertDescription>{t('codexMissingHelp')}</AlertDescription>
                </Alert>
              )}
              <div className="flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs text-muted-foreground">
                  {item.lastSeenAt && (
                    <>
                      {t('lastSeen')} <LocalTime value={item.lastSeenAt} />
                    </>
                  )}
                </span>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    onClick={() => setCheckingId(checkingId === item.id ? null : item.id)}
                  >
                    {t('test')}
                  </Button>
                  <Button variant="ghost" onClick={() => setRevokeId(item.id)}>
                    {t('disconnect')}
                  </Button>
                </div>
              </div>
              {checkingId === item.id && (
                <div className="flex flex-col gap-4 border-t pt-6">
                  <h3 className="text-base font-semibold">{t('testTitle')}</h3>
                  <p className="text-sm leading-6 text-muted-foreground">{t('testDescription')}</p>
                  <CopyText text={t('testPrompt')} label={t('testPromptLabel')} />
                  <Link href="/decisions" className={buttonVariants({ variant: 'outline' })}>
                    {t('openInbox')}
                    <ArrowRightIcon data-icon="inline-end" />
                  </Link>
                  {item.lastDeliveredAt && (
                    <p className="text-sm">
                      {t('lastDelivery')} <LocalTime value={item.lastDeliveredAt} />
                    </p>
                  )}
                </div>
              )}
              {revokeId === item.id && (
                <Alert>
                  <AlertTitle>{t('disconnectTitle')}</AlertTitle>
                  <AlertDescription>
                    {t('disconnectHelp')}
                    <div className="flex gap-2">
                      <Button
                        variant="destructive"
                        disabled={pending}
                        onClick={() => {
                          setPending(true);
                          void revokeConnector(item.id)
                            .then(() => {
                              setError(false);
                              setRevokeId(null);
                              return refresh();
                            })
                            .catch(() => setError(true))
                            .finally(() => setPending(false));
                        }}
                      >
                        {t('confirmDisconnect')}
                      </Button>
                      <Button variant="outline" onClick={() => setRevokeId(null)}>
                        {t('cancel')}
                      </Button>
                    </div>
                  </AlertDescription>
                </Alert>
              )}
            </section>
          ))}
        </PageSurface>
      )}
      {items && items.some((item) => item.status === 'revoked') && (
        <details className="text-sm text-muted-foreground">
          <summary className="cursor-pointer">{t('disconnectedHistory')}</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {items
              .filter((item) => item.status === 'revoked')
              .map((item) => (
                <li key={item.id}>
                  {item.name} · {t('status.revoked')}
                </li>
              ))}
          </ul>
        </details>
      )}
    </PageFrame>
  );
}
