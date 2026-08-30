'use client';

import type { DevelopmentRunDetail } from '@repo/contracts';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@repo/ui/components/card';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@repo/ui/components/field';
import { Separator } from '@repo/ui/components/separator';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { CircleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '../../i18n/navigation';

const phases = [
  'intake',
  'preparing',
  'planning',
  'awaiting_plan_approval',
  'implementing',
  'verifying',
  'awaiting_publication_approval',
  'publishing',
  'reviewing',
  'awaiting_merge',
  'completed',
] as const;

export function DevelopmentDetailView({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const lastSequence = detail.events.at(-1)?.sequence ?? 0;

  useEffect(() => {
    if (['completed', 'failed', 'cancelled'].includes(detail.run.phase)) {
      return;
    }

    const events = new EventSource(
      `/api/v1/development/runs/${detail.run.id}/events?after=${lastSequence}`,
    );

    const refresh = () => router.refresh();

    events.addEventListener('development-event', refresh);
    events.addEventListener('snapshot', refresh);
    return () => {
      events.removeEventListener('development-event', refresh);
      events.removeEventListener('snapshot', refresh);
      events.close();
    };
  }, [detail.run.id, detail.run.phase, lastSequence, router]);

  async function approvePlan(formData: FormData) {
    const interrupt = detail.interrupt;
    if (interrupt?.kind !== 'plan_approval') {
      return;
    }
    const rawResponse = formData.get('response');
    const approvalResponse = typeof rawResponse === 'string' ? rawResponse.trim() : '';
    setPending(true);
    setError(undefined);
    const response = await fetch(`/api/v1/development/runs/${detail.run.id}/plan-approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interrupt_id: interrupt.id,
        expected_lock_version: interrupt.lock_version,
        approve: true,
        response: approvalResponse || undefined,
      }),
    });
    if (!response.ok) {
      setError(t('approvalFailed'));
      setPending(false);
      router.refresh();
      return;
    }
    router.refresh();
  }

  async function approvePublication() {
    const interrupt = detail.interrupt;
    if (interrupt?.kind !== 'publication_approval' || interrupt.candidate_hash === null) {
      return;
    }
    setPending(true);
    setError(undefined);
    const response = await fetch(`/api/v1/development/runs/${detail.run.id}/publication-approval`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interrupt_id: interrupt.id,
        expected_lock_version: interrupt.lock_version,
        candidate_hash: interrupt.candidate_hash,
        approve: true,
      }),
    });
    if (!response.ok) {
      setError(t('approvalFailed'));
      setPending(false);
      router.refresh();
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link href="/development" className="text-sm text-muted-foreground hover:text-foreground">
          ← {t('back')}
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('run')} #{detail.run.id}
          </h1>
          <Badge>{t(`phase_${detail.run.phase}`)}</Badge>
        </div>
        <p className="max-w-3xl text-sm text-muted-foreground">{detail.run.goal}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('graph')}</CardTitle>
          <CardDescription>{t('graphDescription')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-wrap items-center gap-2">
          {phases.map((phase, index) => (
            <span key={phase} className="contents">
              <Badge
                variant={
                  phase === detail.run.phase
                    ? 'default'
                    : phases.indexOf(detail.run.phase as (typeof phases)[number]) > index
                      ? 'secondary'
                      : 'outline'
                }
              >
                {t(`phase_${phase}`)}
              </Badge>
              {index < phases.length - 1 ? (
                <span aria-hidden="true" className="text-muted-foreground">
                  →
                </span>
              ) : null}
            </span>
          ))}
        </CardContent>
      </Card>
      {detail.interrupt?.kind === 'plan_approval' ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>{t('actionRequired')}</AlertTitle>
          <AlertDescription>{detail.interrupt.prompt}</AlertDescription>
        </Alert>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>{t('conversation')}</CardTitle>
            <CardDescription>{t('conversationDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-[36rem] flex-col gap-3 overflow-auto">
            {detail.events.map((event) => (
              <div key={event.sequence} className="flex flex-col gap-1 rounded-lg border p-3">
                <span className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">{event.source}</Badge>
                  <span className="text-xs text-muted-foreground">
                    #{event.sequence} · {new Date(event.observed_at).toLocaleString()}
                  </span>
                </span>
                <strong className="text-sm">{event.type.replaceAll('_', ' ')}</strong>
                {typeof event.payload.message === 'string' ? (
                  <p className="whitespace-pre-wrap text-sm">{event.payload.message}</p>
                ) : null}
              </div>
            ))}
          </CardContent>
        </Card>
        <div className="flex flex-col gap-6">
          {detail.interrupt?.kind === 'plan_approval' ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('approvePlan')}</CardTitle>
                <CardDescription>{t('approvePlanDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <form action={approvePlan}>
                  <FieldGroup>
                    <Field>
                      <FieldLabel htmlFor="plan-response">{t('approvalNote')}</FieldLabel>
                      <Textarea id="plan-response" name="response" rows={3} maxLength={20_000} />
                      <FieldDescription>{t('approvalNoteDescription')}</FieldDescription>
                    </Field>
                    {error ? (
                      <Alert variant="destructive">
                        <AlertTitle>{error}</AlertTitle>
                      </Alert>
                    ) : null}
                    <Button disabled={pending}>
                      {pending ? <Spinner data-icon="inline-start" /> : null}
                      {t('approveAndImplement')}
                    </Button>
                  </FieldGroup>
                </form>
              </CardContent>
            </Card>
          ) : null}
          {detail.interrupt?.kind === 'publication_approval' ? (
            <Card>
              <CardHeader>
                <CardTitle>{t('approvePublication')}</CardTitle>
                <CardDescription>{t('approvePublicationDescription')}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <code className="break-all rounded-md bg-muted p-3 text-xs">
                  {detail.interrupt.candidate_hash}
                </code>
                {error ? (
                  <Alert variant="destructive">
                    <AlertTitle>{error}</AlertTitle>
                  </Alert>
                ) : null}
                <Button onClick={() => void approvePublication()} disabled={pending}>
                  {pending ? <Spinner data-icon="inline-start" /> : null}
                  {t('publishCandidate')}
                </Button>
              </CardContent>
            </Card>
          ) : null}
          <Card>
            <CardHeader>
              <CardTitle>{t('evidence')}</CardTitle>
              <CardDescription>{t('evidenceDescription')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {detail.evidence.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noEvidence')}</p>
              ) : (
                detail.evidence.map((evidence) => (
                  <div key={evidence.id} className="flex flex-col gap-2">
                    <span className="flex items-center justify-between gap-2">
                      <strong className="text-sm">{evidence.criterion}</strong>
                      <Badge
                        variant={
                          evidence.verdict === 'passed'
                            ? 'secondary'
                            : evidence.verdict === 'failed'
                              ? 'destructive'
                              : 'outline'
                        }
                      >
                        {evidence.verdict}
                      </Badge>
                    </span>
                    <p className="text-sm text-muted-foreground">{evidence.observation}</p>
                    <Separator />
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
