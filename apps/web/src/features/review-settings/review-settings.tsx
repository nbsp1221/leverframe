'use client';

import type { ReviewSettingsResponse } from '@repo/contracts/review-settings';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@repo/ui/components/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { CheckIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { PageFrame } from '../../components/page-frame';
import { PageHeader } from '../../components/page-header';
import { PageSurface } from '../../components/page-surface';
import { registerDirtyNavigation } from '../../lib/dirty-navigation';
import { requestReviewSettings } from './review-settings-api';
import { useReviewSettingsDraft } from './review-settings-draft';

export function ReviewSettings() {
  const t = useTranslations('reviewSettings');
  const [data, setData] = useState<ReviewSettingsResponse | null>(null);
  const [retainedDraft, setDraft] = useReviewSettingsDraft();
  const draft = retainedDraft ?? data?.current ?? { model: '', reasoningEffort: '' };
  const [loadError, setLoadError] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirty =
    data !== null &&
    (draft.model !== data.current.model || draft.reasoningEffort !== data.current.reasoningEffort);
  const selectedModel = data?.models.find((model) => model.id === draft.model);
  const selectedEffort = selectedModel?.reasoningEfforts.find(
    (effort) => effort === draft.reasoningEffort,
  );
  const canSave = dirty && selectedEffort !== undefined && !saving;

  const load = useCallback(async () => {
    try {
      const next = await requestReviewSettings();
      setData(next);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!dirty) {
      return;
    }
    const unregister = registerDirtyNavigation(t('unsavedPrompt'), () => setDraft(null));

    const beforeUnload = (event: BeforeUnloadEvent) => event.preventDefault();

    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      unregister();
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, [dirty, t, setDraft]);

  const save = async () => {
    if (!canSave || selectedEffort === undefined) {
      return;
    }
    setSaving(true);
    setSaveError(false);
    setSaved(false);
    try {
      const next = await requestReviewSettings({
        model: draft.model,
        reasoningEffort: selectedEffort,
      });
      setData(next);
      setDraft((current) => (current === retainedDraft ? null : current));
      setSaved(true);
    } catch {
      setSaveError(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageFrame className="flex flex-col gap-6">
      <PageHeader title={t('title')} description={t('description')} />
      {loadError ? (
        <Alert variant="destructive" className="max-w-3xl">
          <AlertTitle>{t('loadError')}</AlertTitle>
          <AlertDescription>
            {t('loadErrorHelp')}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void load();
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {t('retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : data === null ? (
        <PageSurface
          className="flex max-w-3xl flex-col gap-6 p-6 sm:p-8"
          aria-busy="true"
          aria-label={t('loading')}
        >
          <Skeleton className="h-6 w-40" />
          <Skeleton className="h-11 w-full sm:h-10" />
          <Skeleton className="h-11 w-full sm:h-10" />
        </PageSurface>
      ) : (
        <PageSurface className="max-w-3xl">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="flex flex-col gap-7 p-6 sm:p-8">
              <div className="flex flex-col gap-2">
                <h2 className="text-xl font-semibold">{t('modelSection')}</h2>
                <p className="text-sm leading-6 text-muted-foreground">{t('scope')}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-muted-foreground">{t('current')}</span>
                  <Badge variant="secondary">
                    {data.models.find((model) => model.id === data.current.model)?.name ??
                      data.current.model}{' '}
                    · {t(`effort_${data.current.reasoningEffort}`)}
                  </Badge>
                </div>
              </div>
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="review-model">{t('model')}</FieldLabel>
                  <Select
                    value={draft.model}
                    disabled={saving}
                    items={[
                      ...data.models.map((model) => ({ value: model.id, label: model.name })),
                      ...(!selectedModel ? [{ value: draft.model, label: draft.model }] : []),
                    ]}
                    onValueChange={(value) => {
                      if (typeof value !== 'string') {
                        return;
                      }
                      const model = data.models.find((candidate) => candidate.id === value);
                      setDraft({
                        model: value,
                        reasoningEffort: model?.reasoningEfforts.some(
                          (effort) => effort === draft.reasoningEffort,
                        )
                          ? draft.reasoningEffort
                          : '',
                      });
                      setSaved(false);
                      setSaveError(false);
                    }}
                  >
                    <SelectTrigger
                      id="review-model"
                      className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-10"
                      aria-describedby="review-model-help"
                    >
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {!selectedModel && (
                        <SelectItem value={draft.model} disabled>
                          {draft.model}
                        </SelectItem>
                      )}
                      {data.models.map((model) => (
                        <SelectItem key={model.id} value={model.id}>
                          {model.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription id="review-model-help">
                    {t(selectedModel ? 'modelHelp' : 'unsupportedCurrent')}
                  </FieldDescription>
                </Field>
                <Field data-invalid={draft.reasoningEffort === '' || undefined}>
                  <FieldLabel htmlFor="review-reasoning">{t('reasoning')}</FieldLabel>
                  <Select
                    value={draft.reasoningEffort || null}
                    disabled={saving || !selectedModel}
                    items={(selectedModel?.reasoningEfforts ?? [data.current.reasoningEffort]).map(
                      (effort) => ({ value: effort, label: t(`effort_${effort}`) }),
                    )}
                    onValueChange={(value) => {
                      if (typeof value !== 'string') {
                        return;
                      }
                      setDraft({ ...draft, reasoningEffort: value });
                      setSaved(false);
                      setSaveError(false);
                    }}
                  >
                    <SelectTrigger
                      id="review-reasoning"
                      className="w-full data-[size=default]:h-11 sm:data-[size=default]:h-10"
                      aria-invalid={draft.reasoningEffort === ''}
                      aria-describedby="review-reasoning-help"
                    >
                      <SelectValue placeholder={t('chooseEffort')} />
                    </SelectTrigger>
                    <SelectContent>
                      {selectedModel?.reasoningEfforts.map((effort) => (
                        <SelectItem key={effort} value={effort}>
                          {t(`effort_${effort}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription id="review-reasoning-help">
                    {t(draft.reasoningEffort === '' ? 'chooseEffort' : 'reasoningHelp')}
                  </FieldDescription>
                </Field>
              </FieldGroup>
              <p className="text-sm leading-6 text-muted-foreground">{t('application')}</p>
              {saveError && (
                <Alert variant="destructive">
                  <AlertTitle>{t('saveError')}</AlertTitle>
                  <AlertDescription>{t('saveErrorHelp')}</AlertDescription>
                </Alert>
              )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-4 border-t border-border px-6 py-4 sm:px-8">
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                {saved && <CheckIcon className="size-4" aria-hidden="true" />}
                {saving ? t('saving') : saved ? t('saved') : dirty ? t('unsaved') : t('upToDate')}
              </p>
              <div className="ml-auto flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  disabled={!dirty || saving}
                  onClick={() => {
                    setDraft(null);
                    setSaveError(false);
                    setSaved(false);
                  }}
                >
                  {t('cancel')}
                </Button>
                <Button type="submit" disabled={!canSave}>
                  {saving ? t('saving') : t('save')}
                </Button>
              </div>
            </div>
          </form>
        </PageSurface>
      )}
    </PageFrame>
  );
}
