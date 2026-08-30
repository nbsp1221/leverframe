'use client';

import type { DevelopmentRepository } from '@repo/contracts';
import { Button } from '@repo/ui/components/button';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from '@repo/ui/components/combobox';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@repo/ui/components/field';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';

export function DevelopmentCreateForm({ repositories }: { repositories: DevelopmentRepository[] }) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [repository, setRepository] = useState<string | null>(null);
  const repositoryNames = repositories.map((item) => item.repository);

  async function submit(formData: FormData) {
    const rawGoal = formData.get('goal');
    const goal = typeof rawGoal === 'string' ? rawGoal.trim() : '';
    if (!goal || repository === null) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch('/api/v1/development/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ repository, goal }),
      });
      if (!response.ok) {
        throw new Error(t('createFailed'));
      }
      const result = (await response.json()) as { id?: unknown };
      if (typeof result.id !== 'number') {
        throw new Error(t('createFailed'));
      }
      router.push(`/development/${result.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('createFailed'));
      setPending(false);
    }
  }

  return (
    <form action={submit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="development-repository">{t('repository')}</FieldLabel>
          <Combobox items={repositoryNames} value={repository} onValueChange={setRepository}>
            <ComboboxInput
              id="development-repository"
              placeholder={t('repositoryPlaceholder')}
              aria-label={t('repository')}
            />
            <ComboboxContent>
              <ComboboxEmpty>{t('repositoryEmpty')}</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => <ComboboxItem value={item}>{item}</ComboboxItem>}
              </ComboboxList>
            </ComboboxContent>
          </Combobox>
          <FieldDescription>{t('repositoryDescription')}</FieldDescription>
        </Field>
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor="development-goal">{t('goal')}</FieldLabel>
          <Textarea
            id="development-goal"
            name="goal"
            required
            maxLength={20_000}
            rows={5}
            placeholder={t('goalPlaceholder')}
            aria-invalid={error !== undefined}
          />
          <FieldError>{error}</FieldError>
        </Field>
        <Button type="submit" disabled={pending || repository === null}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {t('startRun')}
        </Button>
      </FieldGroup>
    </form>
  );
}
