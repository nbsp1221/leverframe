'use client';

import type { DevelopmentTicket } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import { Field, FieldDescription, FieldLabel } from '@repo/ui/components/field';
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
import { ArrowDownIcon, ArrowUpIcon, ChevronLeftIcon, ChevronRightIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useMemo, useState } from 'react';

const ticketsPerPage = 5;

export function DevelopmentTicketPicker({
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
  const statusLabels: Record<string, string> = {
    backlog: t('ticketStatusBacklog'),
    planned: t('ticketStatusPlanned'),
    in_progress: t('ticketStatusInProgress'),
    in_review: t('ticketStatusInReview'),
    done: t('ticketStatusDone'),
    cancelled: t('ticketStatusCancelled'),
  };
  const sortLabels = {
    key: t('ticketSortKey'),
    title: t('ticketSortTitle'),
    status: t('ticketSortStatus'),
    priority: t('ticketSortPriority'),
  };
  const priorityLabels: Record<string, string> = {
    none: t('ticketPriorityNone'),
    low: t('ticketPriorityLow'),
    medium: t('ticketPriorityMedium'),
    high: t('ticketPriorityHigh'),
    urgent: t('ticketPriorityUrgent'),
  };
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
        const result = compareText(ticketSortValue(left, sort), ticketSortValue(right, sort));
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
              <SelectValue>
                {status === 'all'
                  ? t('ticketStatusAll')
                  : (statusLabels[status] ?? status.replaceAll('_', ' '))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                <SelectItem value="all">{t('ticketStatusAll')}</SelectItem>
                {statuses.map((item) => (
                  <SelectItem key={item} value={item}>
                    {statusLabels[item] ?? item.replaceAll('_', ' ')}
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
              <SelectValue>{sortLabels[sort]}</SelectValue>
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
                      <Badge variant="secondary">
                        {statusLabels[ticket.status] ?? ticket.status.replaceAll('_', ' ')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {ticket.priority === null
                        ? t('ticketPriorityNone')
                        : (priorityLabels[ticket.priority] ?? ticket.priority)}
                    </TableCell>
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
