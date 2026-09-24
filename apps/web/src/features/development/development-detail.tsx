'use client';

import type { DevelopmentInterrupt, DevelopmentRunDetail } from '@repo/contracts';
import { Alert, AlertTitle } from '@repo/ui/components/alert';
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
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
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
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@repo/ui/components/sheet';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { ArrowLeftIcon, ChevronDownIcon, ChevronUpIcon, PanelRightIcon, XIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { Link, useRouter } from '../../i18n/navigation';
import { DevelopmentRunOverview } from './development-run-overview';
import { DevelopmentActivity, DevelopmentWorkflowOverview } from './development-run-presentation';

export function DevelopmentDetailView({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pendingInterruptId, setPendingInterruptId] = useState<number>();
  const [approvalError, setApprovalError] = useState<{ interruptId: number; message: string }>();
  const { pendingRunAction, runAction, runActionError } = useRunResourceAction(detail.run.id);
  const lastSequence = detail.events.at(-1)?.sequence ?? 0;
  const pending = pendingInterruptId === detail.interrupt?.id;
  const error =
    approvalError !== undefined && approvalError.interruptId === detail.interrupt?.id
      ? approvalError.message
      : undefined;

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

  const interrupt = (() => {
    if (detail.interrupt?.kind === 'clarification' && detail.interrupt.questions !== null) {
      return (
        <ClarificationAction
          interrupt={{ ...detail.interrupt, questions: detail.interrupt.questions }}
          runId={detail.run.id}
        />
      );
    }
    if (detail.interrupt?.kind === 'plan_approval') {
      return <PlanApprovalAction error={error} pending={pending} approvePlan={approvePlan} />;
    }
    if (detail.interrupt?.kind === 'publication_approval') {
      return (
        <PublicationApprovalAction
          candidateHash={detail.interrupt.candidate_hash}
          error={error}
          pending={pending}
          approvePublication={approvePublication}
        />
      );
    }
    return null;
  })();

  return (
    <div className="-my-6 flex h-[calc(100svh-4.5rem)] min-h-[48rem] min-w-0 flex-col lg:h-[calc(100svh-5.5rem)]">
      <DevelopmentRunHeader
        detail={detail}
        pendingAction={pendingRunAction}
        onAction={(action) => void runAction(action)}
      />
      <div className="mx-auto flex min-h-0 w-full max-w-6xl flex-1 flex-col px-4 sm:px-6 lg:px-8">
        {runActionError === undefined ? null : (
          <Alert variant="destructive" className="mt-4 shrink-0">
            <AlertTitle>{runActionError}</AlertTitle>
          </Alert>
        )}
        <DevelopmentWorkflowOverview detail={detail} />
        <Separator />
        <div className="mx-auto flex min-h-0 w-full max-w-[800px] flex-1 flex-col pt-4">
          <DevelopmentActivity events={detail.events} />
          {interrupt === null ? null : (
            <section aria-label={t('actionRequired')} className="shrink-0 pt-3 pb-2">
              <Separator className="mb-4" />
              {interrupt}
            </section>
          )}
        </div>
      </div>
    </div>
  );
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
  const goalSummary = summarizeGoal(detail.run.goal);

  return (
    <header className="-mx-4 flex min-h-12 min-w-0 items-center gap-2 border-b px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8">
      <Button
        variant="ghost"
        size="icon-sm"
        nativeButton={false}
        aria-label={t('back')}
        render={<Link href="/development" />}
      >
        <ArrowLeftIcon aria-hidden="true" />
      </Button>
      <span className="shrink-0 text-xs text-muted-foreground">
        <span className="hidden sm:inline">{t('run')} </span>#{detail.run.id}
      </span>
      <h1 className="truncate text-sm font-medium" title={detail.run.goal}>
        {goalSummary}
      </h1>
      <Badge className="hidden shrink-0 sm:inline-flex" variant="secondary">
        {t(`phase_${detail.run.phase}`)}
      </Badge>
      <span
        className="hidden max-w-48 truncate text-xs text-muted-foreground md:inline"
        title={detail.run.repository}
      >
        {detail.run.repository}
      </span>
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Sheet>
          <SheetTrigger render={<Button type="button" variant="outline" size="sm" />}>
            <PanelRightIcon data-icon="inline-start" aria-hidden="true" />
            {t('details')}
          </SheetTrigger>
          <SheetContent
            showCloseButton={false}
            className="gap-0 p-0 data-[side=right]:w-full sm:data-[side=right]:max-w-sm"
          >
            <SheetHeader className="border-b">
              <SheetTitle>{t('runDetails')}</SheetTitle>
              <SheetDescription>{t('runDetailsDescription')}</SheetDescription>
            </SheetHeader>
            <SheetClose
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="absolute top-3 right-3"
                  aria-label={t('closeDetails')}
                />
              }
            >
              <XIcon aria-hidden="true" />
            </SheetClose>
            <div
              className="min-h-0 overflow-y-auto px-2 pb-4"
              tabIndex={0}
              role="region"
              aria-label={t('runDetailsContent')}
            >
              <DevelopmentRunOverview detail={detail} />
            </div>
          </SheetContent>
        </Sheet>
        <RunResourceActions detail={detail} pendingAction={pendingAction} onAction={onAction} />
      </div>
    </header>
  );
}

function summarizeGoal(goal: string): string {
  const firstLine = goal.split(/\r?\n/, 1)[0]?.replaceAll(/\s+/g, ' ').trim() ?? '';
  return firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine;
}

function useRunResourceAction(runId: number) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pendingRunAction, setPendingRunAction] = useState<'cancel' | 'cleanup'>();
  const [runActionError, setRunActionError] = useState<string>();

  async function runAction(action: 'cancel' | 'cleanup') {
    setPendingRunAction(action);
    setRunActionError(undefined);
    const response = await fetch(`/api/v1/development/runs/${runId}/${action}`, { method: 'POST' });
    if (!response.ok) {
      setPendingRunAction(undefined);
      setRunActionError(t(action === 'cancel' ? 'cancelFailed' : 'cleanupFailed'));
      router.refresh();
      return;
    }
    router.refresh();
  }

  return { pendingRunAction, runAction, runActionError };
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
      <RunActionDialog
        label={t('cancelRun')}
        confirmation={t('cancelConfirmation')}
        pending={pendingAction === 'cancel'}
        onConfirm={() => onAction('cancel')}
      />
    );
  }
  if (
    detail.run.phase !== 'completed' ||
    detail.resources.every((resource) => resource.state === 'cleaned')
  ) {
    return null;
  }
  return (
    <RunActionDialog
      label={t('cleanupRun')}
      confirmation={t('cleanupConfirmation')}
      pending={pendingAction === 'cleanup'}
      onConfirm={() => onAction('cleanup')}
    />
  );
}

function RunActionDialog({
  label,
  confirmation,
  pending,
  onConfirm,
}: {
  label: string;
  confirmation: string;
  pending: boolean;
  onConfirm: () => void;
}) {
  const t = useTranslations('development');
  return (
    <AlertDialog>
      <AlertDialogTrigger
        disabled={pending}
        render={<Button type="button" variant="outline" size="sm" />}
      >
        {pending ? <Spinner data-icon="inline-start" /> : null}
        {label}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{label}</AlertDialogTitle>
          <AlertDialogDescription>{confirmation}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
          <AlertDialogAction disabled={pending} onClick={onConfirm}>
            {t('confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PlanApprovalAction({
  error,
  pending,
  approvePlan,
}: {
  error: string | undefined;
  pending: boolean;
  approvePlan: (formData: FormData) => Promise<void>;
}) {
  const t = useTranslations('development');
  const [noteOpen, setNoteOpen] = useState(false);

  return (
    <form action={approvePlan}>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t('approvePlan')}</CardTitle>
          <CardDescription>{t('approvePlanDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <Collapsible open={noteOpen} onOpenChange={setNoteOpen}>
            <CollapsibleTrigger render={<Button type="button" variant="link" className="px-0" />}>
              {noteOpen ? (
                <ChevronUpIcon data-icon="inline-start" />
              ) : (
                <ChevronDownIcon data-icon="inline-start" />
              )}
              {noteOpen ? t('hideApprovalNote') : t('addApprovalNote')}
            </CollapsibleTrigger>
            <CollapsibleContent className="pt-2">
              <Field>
                <FieldLabel htmlFor="plan-response">{t('approvalNote')}</FieldLabel>
                <Textarea id="plan-response" name="response" rows={3} maxLength={20_000} />
                <FieldDescription>{t('approvalNoteDescription')}</FieldDescription>
              </Field>
            </CollapsibleContent>
          </Collapsible>
          {error ? (
            <Alert variant="destructive" className="mt-3">
              <AlertTitle>{error}</AlertTitle>
            </Alert>
          ) : null}
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {t('approveAndImplement')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}

function PublicationApprovalAction({
  candidateHash,
  error,
  pending,
  approvePublication,
}: {
  candidateHash: string | null;
  error: string | undefined;
  pending: boolean;
  approvePublication: () => Promise<void>;
}) {
  const t = useTranslations('development');
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('approvePublication')}</CardTitle>
        <CardDescription>{t('approvePublicationDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        {candidateHash === null ? null : (
          <p className="text-xs text-muted-foreground">
            {t('candidate')}: <code title={candidateHash}>{candidateHash.slice(0, 12)}</code>
          </p>
        )}
        {error ? (
          <Alert variant="destructive" className="mt-3">
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        ) : null}
      </CardContent>
      <CardFooter className="justify-end">
        <Button
          onClick={() => void approvePublication()}
          disabled={pending || candidateHash === null}
        >
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {t('publishCandidate')}
        </Button>
      </CardFooter>
    </Card>
  );
}

function ClarificationAction({
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
    <form action={answer}>
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t('clarification')}</CardTitle>
          <CardDescription>{t('clarificationDescription')}</CardDescription>
        </CardHeader>
        <CardContent>
          <FieldGroup>
            {interrupt.questions.map((question) => (
              <Field key={question.id}>
                <FieldLabel htmlFor={`question-${question.id}`}>{question.header}</FieldLabel>
                <FieldDescription>{question.question}</FieldDescription>
                {question.options === null ? null : (
                  <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-muted-foreground">
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
          </FieldGroup>
        </CardContent>
        <CardFooter className="justify-end">
          <Button type="submit" disabled={pending}>
            {pending ? <Spinner data-icon="inline-start" /> : null}
            {t('sendAnswers')}
          </Button>
        </CardFooter>
      </Card>
    </form>
  );
}
