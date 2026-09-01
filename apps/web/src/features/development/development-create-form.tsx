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
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
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
import { ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useRouter } from '../../i18n/navigation';
import { DevelopmentTicketPicker } from './development-ticket-picker';

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
  const [ticketPickerOpen, setTicketPickerOpen] = useState(false);
  const repositoryNames = repositories.map((item) => item.repository);

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
        <Collapsible open={ticketPickerOpen} onOpenChange={setTicketPickerOpen}>
          <CollapsibleTrigger
            render={
              <Button type="button" variant="ghost" className="w-full justify-between px-0" />
            }
          >
            <span className="flex flex-col items-start gap-0.5 text-left">
              <span>{t('ticketImport')}</span>
              <span className="text-xs font-normal text-muted-foreground">
                {tickets === null ? t('ticketUnavailableShort') : t('ticketImportDescription')}
              </span>
            </span>
            {ticketPickerOpen ? (
              <ChevronUpIcon data-icon="inline-end" />
            ) : (
              <ChevronDownIcon data-icon="inline-end" />
            )}
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-4">
            {tickets === null ? (
              <FieldDescription>{t('ticketUnavailable')}</FieldDescription>
            ) : (
              <DevelopmentTicketPicker
                tickets={tickets}
                selectedId={ticketId}
                pending={pending}
                onSelect={(id) => {
                  setTicketId(id);
                  setExternalSource(undefined);
                  setRepositorySuggestions(undefined);
                }}
                onImport={() => void importTicket()}
              />
            )}
          </CollapsibleContent>
        </Collapsible>
        <Field>
          <FieldLabel htmlFor="development-repository">{t('repository')}</FieldLabel>
          <Combobox items={repositoryNames} value={repository} onValueChange={setRepository}>
            <ComboboxInput
              id="development-repository"
              placeholder={t('repositoryPlaceholder')}
              aria-label={t('repository')}
              triggerAriaLabel={t('repositoryOpen')}
            />
            <ComboboxContent>
              <ComboboxEmpty>{t('repositoryEmpty')}</ComboboxEmpty>
              <ComboboxList>
                {(item: string) => (
                  <ComboboxItem key={item} value={item}>
                    {item}
                  </ComboboxItem>
                )}
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
