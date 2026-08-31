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
import { Input } from '@repo/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select';
import { Spinner } from '@repo/ui/components/spinner';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@repo/ui/components/table';
import { Textarea } from '@repo/ui/components/textarea';
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';
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
          <TicketPicker
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

const ticketsPerPage = 5;

function TicketPicker({
  tickets,
  selectedId,
  pending,
  onSelect,
  onImport,
}: {
  tickets: DevelopmentTicket[];
  selectedId: string | null;
  pending: boolean;
  onSelect: (id: string) => void;
  onImport: () => void;
}) {
  const t = useTranslations('development');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [sort, setSort] = useState<'key' | 'title' | 'status' | 'priority'>('key');
  const [descending, setDescending] = useState(false);
  const [page, setPage] = useState(1);
  const statuses = useMemo(
    () => [...new Set(tickets.map((ticket) => ticket.status))].sort(compareText),
    [tickets],
  );
  const matching = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase('en-US');
    return tickets
      .filter(
        (ticket) =>
          (status === 'all' || ticket.status === status) &&
          (normalizedQuery === '' ||
            `${ticket.key} ${ticket.title}`.toLocaleLowerCase('en-US').includes(normalizedQuery)),
      )
      .sort((left, right) => {
        const leftValue = ticketSortValue(left, sort);
        const rightValue = ticketSortValue(right, sort);
        const result = compareText(leftValue, rightValue);
        return descending ? -result : result;
      });
  }, [descending, query, sort, status, tickets]);
  const pageCount = Math.max(1, Math.ceil(matching.length / ticketsPerPage));
  const currentPage = Math.min(page, pageCount);
  const visible = matching.slice((currentPage - 1) * ticketsPerPage, currentPage * ticketsPerPage);

  return (
    <Field>
      <FieldLabel htmlFor="development-ticket-search">{t('ticket')}</FieldLabel>
      <div className="flex flex-col gap-2">
        <Input
          id="development-ticket-search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(1);
          }}
          placeholder={t('ticketPlaceholder')}
        />
        <div className="flex flex-wrap gap-2">
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value ?? 'all');
              setPage(1);
            }}
          >
            <SelectTrigger aria-label={t('ticketStatusFilter')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t('ticketStatusAll')}</SelectItem>
                {statuses.map((item) => (
                  <SelectItem key={item} value={item}>
                    {item}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <Select
            value={sort}
            onValueChange={(value) => {
              if (
                value === 'key' ||
                value === 'title' ||
                value === 'status' ||
                value === 'priority'
              ) {
                setSort(value);
                setPage(1);
              }
            }}
          >
            <SelectTrigger aria-label={t('ticketSort')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="key">{t('ticketSortKey')}</SelectItem>
                <SelectItem value="title">{t('ticketSortTitle')}</SelectItem>
                <SelectItem value="status">{t('ticketSortStatus')}</SelectItem>
                <SelectItem value="priority">{t('ticketSortPriority')}</SelectItem>
              </SelectGroup>
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label={descending ? t('ticketSortAscending') : t('ticketSortDescending')}
            onClick={() => {
              setDescending((current) => !current);
              setPage(1);
            }}
          >
            {descending ? <ArrowDownIcon /> : <ArrowUpIcon />}
          </Button>
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('ticketColumnTicket')}</TableHead>
                <TableHead>{t('ticketColumnStatus')}</TableHead>
                <TableHead>{t('ticketColumnPriority')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={3} className="text-center text-muted-foreground">
                    {t('ticketEmpty')}
                  </TableCell>
                </TableRow>
              ) : (
                visible.map((ticket) => (
                  <TableRow
                    key={ticket.id}
                    data-state={ticket.id === selectedId ? 'selected' : undefined}
                  >
                    <TableCell className="max-w-64 whitespace-normal">
                      <Button
                        type="button"
                        variant="ghost"
                        className="h-auto w-full justify-start whitespace-normal px-0 text-left"
                        aria-pressed={ticket.id === selectedId}
                        onClick={() => onSelect(ticket.id)}
                      >
                        <span>
                          <span className="font-medium">{ticket.key}</span> {ticket.title}
                        </span>
                      </Button>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{ticket.status}</Badge>
                    </TableCell>
                    <TableCell>{ticket.priority ?? t('ticketPriorityNone')}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {t('ticketPage', { page: currentPage, pages: pageCount, count: matching.length })}
          </span>
          <div className="flex gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={currentPage === 1}
              aria-label={t('ticketPreviousPage')}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeftIcon />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon-sm"
              disabled={currentPage === pageCount}
              aria-label={t('ticketNextPage')}
              onClick={() => setPage((current) => Math.min(pageCount, current + 1))}
            >
              <ChevronRightIcon />
            </Button>
          </div>
        </div>
        <Button
          type="button"
          variant="outline"
          disabled={pending || selectedId === null}
          onClick={onImport}
        >
          {pending ? <Spinner data-icon="inline-start" /> : null}
          {t('importTicket')}
        </Button>
      </div>
      <FieldDescription>{t('ticketDescription')}</FieldDescription>
    </Field>
  );
}

function ticketSortValue(
  ticket: DevelopmentTicket,
  sort: 'key' | 'title' | 'status' | 'priority',
): string {
  return sort === 'priority' ? (ticket.priority ?? '') : ticket[sort];
}

function compareText(left: string, right: string): number {
  return left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
}
