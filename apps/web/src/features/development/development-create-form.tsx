'use client';

import { Button } from '@repo/ui/components/button';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import { Spinner } from '@repo/ui/components/spinner';
import { Textarea } from '@repo/ui/components/textarea';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';

export function DevelopmentCreateForm({ repository }: { repository: string }) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(formData: FormData) {
    const rawGoal = formData.get('goal');
    const goal = typeof rawGoal === 'string' ? rawGoal.trim() : '';
    if (!goal) {
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
          <Input id="development-repository" value={repository} readOnly />
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
        <Button type="submit" disabled={pending || repository === ''}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {t('startRun')}
        </Button>
      </FieldGroup>
    </form>
  );
}
