'use client';

import type { DevelopmentInterrupt, DevelopmentRunDetail } from '@repo/contracts';
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@repo/ui/components/field';
import { Separator } from '@repo/ui/components/separator';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { ChevronDownIcon, ChevronUpIcon, CircleAlertIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '../../i18n/navigation';
import { DevelopmentActivity, DevelopmentWorkflowProgress } from './development-run-presentation';

export function DevelopmentDetailView({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  const locale = useLocale();
  const router = useRouter();
  const [pendingInterruptId, setPendingInterruptId] = useState<number>();
  const [approvalError, setApprovalError] = useState<{ interruptId: number; message: string }>();
  const { pendingRunAction, runAction } = useRunResourceAction(detail.run.id);
  const lastSequence = detail.events.at(-1)?.sequence ?? 0;
  const pending = pendingInterruptId === detail.interrupt?.id;
  const error =
    approvalError !== undefined && approvalError.interruptId === detail.interrupt?.id
      ? approvalError.message
      : undefined;
  const dateTime = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' });

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
    setPendingInterruptId(interrupt.id);
    setApprovalError(undefined);
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
      setApprovalError({ interruptId: interrupt.id, message: t('approvalFailed') });
      setPendingInterruptId(undefined);
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
    setPendingInterruptId(interrupt.id);
    setApprovalError(undefined);
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
      setApprovalError({ interruptId: interrupt.id, message: t('approvalFailed') });
      setPendingInterruptId(undefined);
      router.refresh();
      return;
    }
    router.refresh();
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <DevelopmentRunHeader
        detail={detail}
        pendingAction={pendingRunAction}
        onAction={(action) => void runAction(action)}
      />
      {detail.interrupt?.kind === 'plan_approval' || detail.interrupt?.kind === 'clarification' ? (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>{t('actionRequired')}</AlertTitle>
          <AlertDescription>{detail.interrupt.prompt}</AlertDescription>
        </Alert>
      ) : null}
      <DevelopmentWorkflowProgress detail={detail} />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
        <DevelopmentActivity events={detail.events} />
        <div className="flex flex-col gap-6">
          {detail.external_source === null ? null : (
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t('externalSource')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3 text-sm">
                <span className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground">{detail.external_source.provider}</span>
                  {detail.external_source.url === null ? (
                    <strong>{detail.external_source.key ?? detail.external_source.id}</strong>
                  ) : (
                    <a
                      className="font-medium underline-offset-4 hover:underline"
                      href={detail.external_source.url}
                      rel="noreferrer"
                      target="_blank"
                    >
                      {detail.external_source.key ?? detail.external_source.id}
                    </a>
                  )}
                </span>
                {detail.external_sync === null ? (
                  <p className="text-muted-foreground">{t('externalSyncPending')}</p>
                ) : (
                  <div className="flex flex-col gap-1">
                    <span className="flex items-center justify-between gap-3">
                      <span>{t('externalSync')}</span>
                      <Badge
                        variant={
                          detail.external_sync.state === 'confirmed' ? 'secondary' : 'outline'
                        }
                      >
                        {detail.external_sync.status}
                      </Badge>
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {t(`externalSyncState_${detail.external_sync.state}`)} ·{' '}
                      {dateTime.format(new Date(detail.external_sync.updated_at))}
                    </span>
                    {detail.external_sync.last_error === null ? null : (
                      <p className="text-xs text-destructive">{detail.external_sync.last_error}</p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
          {detail.interrupt?.kind === 'clarification' && detail.interrupt.questions !== null ? (
            <ClarificationCard
              interrupt={{ ...detail.interrupt, questions: detail.interrupt.questions }}
              runId={detail.run.id}
            />
          ) : null}
          {detail.interrupt?.kind === 'plan_approval' ? (
            <Card size="sm">
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
                    <Button type="submit" disabled={pending}>
                      {pending ? <Spinner data-icon="inline-start" /> : null}
                      {t('approveAndImplement')}
                    </Button>
                  </FieldGroup>
                </form>
              </CardContent>
            </Card>
          ) : null}
          {detail.interrupt?.kind === 'publication_approval' ? (
            <Card size="sm">
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
          {detail.evidence.length === 0 ? null : (
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t('evidence')}</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {detail.evidence.map((evidence) => (
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
                ))}
              </CardContent>
            </Card>
          )}
          <DevelopmentResourcesCard detail={detail} />
        </div>
      </div>
    </div>
  );
}

function useRunResourceAction(runId: number) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pendingRunAction, setPendingRunAction] = useState<'cancel' | 'cleanup'>();

  async function runAction(action: 'cancel' | 'cleanup') {
    if (!window.confirm(t(action === 'cancel' ? 'cancelConfirmation' : 'cleanupConfirmation'))) {
      return;
    }
    setPendingRunAction(action);
    const response = await fetch(`/api/v1/development/runs/${runId}/${action}`, { method: 'POST' });
    if (!response.ok) {
      setPendingRunAction(undefined);
      window.alert(t(action === 'cancel' ? 'cancelFailed' : 'cleanupFailed'));
      router.refresh();
      return;
    }
    router.refresh();
  }

  return { pendingRunAction, runAction };
}

function DevelopmentRunHeader({
  detail,
  pendingAction,
  onAction,
}: {
  detail: DevelopmentRunDetail;
  pendingAction: 'cancel' | 'cleanup' | undefined;
  onAction: (action: 'cancel' | 'cleanup') => void;
}) {
  const t = useTranslations('development');
  return (
    <div className="flex flex-col gap-2">
      <Link href="/development" className="text-sm text-muted-foreground hover:text-foreground">
        ← {t('back')}
      </Link>
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold tracking-tight">
          {t('run')} #{detail.run.id}
        </h1>
        <Badge>{t(`phase_${detail.run.phase}`)}</Badge>
        <RunResourceActions detail={detail} pendingAction={pendingAction} onAction={onAction} />
      </div>
      <GoalSummary goal={detail.run.goal} />
      <p className="text-sm text-muted-foreground">
        {t('repository')}:{' '}
        <span className="font-medium text-foreground">{detail.run.repository}</span>
      </p>
    </div>
  );
}

function GoalSummary({ goal }: { goal: string }) {
  const t = useTranslations('development');
  const [open, setOpen] = useState(false);
  const summary = goal.split(/\r?\n/, 1)[0]?.replaceAll(/\s+/g, ' ').trim() ?? '';
  const needsDisclosure = summary !== goal.trim() || summary.length > 240;

  if (!needsDisclosure) {
    return <p className="max-w-3xl text-sm text-muted-foreground">{summary}</p>;
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-3xl">
      {open ? null : <p className="line-clamp-2 text-sm text-muted-foreground">{summary}</p>}
      <CollapsibleContent>
        <p className="whitespace-pre-wrap text-sm text-muted-foreground">{goal}</p>
      </CollapsibleContent>
      <CollapsibleTrigger
        render={<Button type="button" variant="link" size="sm" className="px-0" />}
      >
        {open ? (
          <ChevronUpIcon data-icon="inline-start" />
        ) : (
          <ChevronDownIcon data-icon="inline-start" />
        )}
        {open ? t('showLess') : t('showFullGoal')}
      </CollapsibleTrigger>
    </Collapsible>
  );
}

function RunResourceActions({
  detail,
  pendingAction,
  onAction,
}: {
  detail: DevelopmentRunDetail;
  pendingAction: 'cancel' | 'cleanup' | undefined;
  onAction: (action: 'cancel' | 'cleanup') => void;
}) {
  const t = useTranslations('development');
  if (!['completed', 'failed', 'cancelled'].includes(detail.run.phase)) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pendingAction !== undefined}
        onClick={() => onAction('cancel')}
      >
        {pendingAction === 'cancel' ? <Spinner data-icon="inline-start" /> : null}
        {t('cancelRun')}
      </Button>
    );
  }
  if (
    detail.run.phase !== 'completed' ||
    detail.resources.every((resource) => resource.state === 'cleaned')
  ) {
    return null;
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={pendingAction !== undefined}
      onClick={() => onAction('cleanup')}
    >
      {pendingAction === 'cleanup' ? <Spinner data-icon="inline-start" /> : null}
      {t('cleanupRun')}
    </Button>
  );
}

function DevelopmentResourcesCard({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('resources')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {detail.resources.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noResources')}</p>
        ) : (
          detail.resources.map((resource) => (
            <div key={resource.kind} className="flex items-center justify-between gap-3 text-sm">
              <span className="flex min-w-0 flex-col">
                <strong>{t(`resource_${resource.kind}`)}</strong>
                <span className="truncate text-xs text-muted-foreground">
                  {resource.external_id}
                </span>
              </span>
              <Badge variant={resource.state === 'cleanup_failed' ? 'destructive' : 'outline'}>
                {t(`resourceState_${resource.state}`)}
              </Badge>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function ClarificationCard({
  interrupt,
  runId,
}: {
  interrupt: Pick<DevelopmentInterrupt, 'id' | 'lock_version'> & {
    questions: NonNullable<DevelopmentInterrupt['questions']>;
  };
  runId: number;
}) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function answer(formData: FormData) {
    const answers = Object.fromEntries(
      interrupt.questions.map((question) => {
        const value = formData.get(`question:${question.id}`);
        return [question.id, [typeof value === 'string' ? value.trim() : '']];
      }),
    );
    if (Object.values(answers).some(([value]) => value === '')) {
      setError(t('answerRequired'));
      return;
    }
    setPending(true);
    setError(undefined);
    const response = await fetch(`/api/v1/development/runs/${runId}/clarification-answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        interrupt_id: interrupt.id,
        expected_lock_version: interrupt.lock_version,
        answers,
      }),
    });
    if (!response.ok) {
      setError(t('answerFailed'));
      setPending(false);
      router.refresh();
      return;
    }
    router.refresh();
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('clarification')}</CardTitle>
        <CardDescription>{t('clarificationDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <form action={answer}>
          <FieldGroup>
            {interrupt.questions.map((question) => (
              <Field key={question.id}>
                <FieldLabel htmlFor={`question-${question.id}`}>{question.header}</FieldLabel>
                <FieldDescription>{question.question}</FieldDescription>
                {question.options === null ? null : (
                  <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                    {question.options.map((option) => (
                      <li key={option.label}>
                        <strong className="text-foreground">{option.label}</strong>
                        {option.description === '' ? null : ` — ${option.description}`}
                      </li>
                    ))}
                  </ul>
                )}
                <Textarea
                  id={`question-${question.id}`}
                  name={`question:${question.id}`}
                  rows={3}
                  maxLength={4000}
                  required
                />
              </Field>
            ))}
            {error ? (
              <Alert variant="destructive">
                <AlertTitle>{error}</AlertTitle>
              </Alert>
            ) : null}
            <Button type="submit" disabled={pending}>
              {pending ? <Spinner data-icon="inline-start" /> : null}
              {t('sendAnswers')}
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  );
}
