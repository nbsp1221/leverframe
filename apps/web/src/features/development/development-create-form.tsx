'use client';

import {
  type DevelopmentRepository,
  type DevelopmentTicket,
  type DevelopmentTicketImport,
  developmentTicketImportSchema,
} from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
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

export function DevelopmentCreateForm({
  repositories,
  tickets,
}: {
  repositories: DevelopmentRepository[];
  tickets: DevelopmentTicket[] | null;
}) {
  const t = useTranslations('development');
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [repository, setRepository] = useState<string | null>(null);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [externalSource, setExternalSource] =
    useState<DevelopmentTicketImport['external_source']>();
  const [goal, setGoal] = useState('');
  const [repositorySuggestions, setRepositorySuggestions] =
    useState<DevelopmentTicketImport['repository_suggestions']>();
  const repositoryNames = repositories.map((item) => item.repository);
  const ticketLabels = tickets?.map(ticketLabel) ?? [];

  async function submit() {
    const acceptedGoal = goal.trim();
    if (!acceptedGoal || repository === null) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch('/api/v1/development/runs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          repository,
          goal: acceptedGoal,
          ...(externalSource === undefined ? {} : { external_source: externalSource }),
        }),
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

  async function importTicket() {
    if (ticketId === null) {
      return;
    }
    setPending(true);
    setError(undefined);
    try {
      const response = await fetch(
        `/api/v1/development/tickets/${encodeURIComponent(ticketId)}/import`,
      );
      if (!response.ok) {
        throw new Error(t('ticketImportFailed'));
      }
      const imported = developmentTicketImportSchema.parse(await response.json());
      const accessible = imported.repository_suggestions.filter((item) => item.accessible);
      setGoal(imported.goal);
      setExternalSource(imported.external_source);
      setRepositorySuggestions(imported.repository_suggestions);
      setRepository(accessible.length === 1 ? accessible[0]!.repository : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('ticketImportFailed'));
    } finally {
      setPending(false);
    }
  }

  return (
    <form action={submit}>
      <FieldGroup>
        {tickets === null ? (
          <FieldDescription>{t('ticketUnavailable')}</FieldDescription>
        ) : (
          <Field>
            <FieldLabel htmlFor="development-ticket">{t('ticket')}</FieldLabel>
            <div className="flex gap-2">
              <Combobox
                items={ticketLabels}
                value={ticketLabel(tickets.find((ticket) => ticket.id === ticketId))}
                onValueChange={(label) => {
                  setTicketId(tickets.find((ticket) => ticketLabel(ticket) === label)?.id ?? null);
                  setExternalSource(undefined);
                  setRepositorySuggestions(undefined);
                }}
              >
                <ComboboxInput
                  id="development-ticket"
                  className="flex-1"
                  placeholder={t('ticketPlaceholder')}
                  aria-label={t('ticket')}
                />
                <ComboboxContent>
                  <ComboboxEmpty>{t('ticketEmpty')}</ComboboxEmpty>
                  <ComboboxList>
                    {(label: string) => <ComboboxItem value={label}>{label}</ComboboxItem>}
                  </ComboboxList>
                </ComboboxContent>
              </Combobox>
              <Button
                type="button"
                variant="outline"
                disabled={pending || ticketId === null}
                onClick={() => void importTicket()}
              >
                {t('importTicket')}
              </Button>
            </div>
            <FieldDescription>{t('ticketDescription')}</FieldDescription>
          </Field>
        )}
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
          {repositorySuggestions === undefined ? null : (
            <div
              className="flex flex-col gap-2 rounded-lg border p-3"
              aria-label={t('repositorySuggestions')}
            >
              <p className="text-sm font-medium">{t('repositorySuggestions')}</p>
              {repositorySuggestions.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('repositorySuggestionsEmpty')}</p>
              ) : (
                repositorySuggestions.map((suggestion) => (
                  <Button
                    key={suggestion.repository}
                    type="button"
                    variant="outline"
                    className="justify-between"
                    disabled={!suggestion.accessible}
                    onClick={() => setRepository(suggestion.repository)}
                  >
                    {suggestion.repository}
                    <Badge variant={suggestion.accessible ? 'secondary' : 'destructive'}>
                      {suggestion.accessible
                        ? t('repositoryAccessible')
                        : t('repositoryNotAccessible')}
                    </Badge>
                  </Button>
                ))
              )}
            </div>
          )}
        </Field>
        <Field data-invalid={error !== undefined}>
          <FieldLabel htmlFor="development-goal">{t('goal')}</FieldLabel>
          <Textarea
            id="development-goal"
            name="goal"
            required
            maxLength={20_000}
            rows={5}
            value={goal}
            onChange={(event) => setGoal(event.target.value)}
            placeholder={t('goalPlaceholder')}
            aria-invalid={error !== undefined}
          />
          <FieldError>{error}</FieldError>
        </Field>
        <Button type="submit" disabled={pending || repository === null || goal.trim() === ''}>
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {t('startRun')}
        </Button>
      </FieldGroup>
    </form>
  );
}

function ticketLabel(ticket: DevelopmentTicket | undefined): string | null {
  return ticket === undefined ? null : `${ticket.key} ${ticket.title}`;
}
