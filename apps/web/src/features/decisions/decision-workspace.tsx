'use client';

import type { Decision } from '@repo/contracts/decisions';
import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Badge } from '@repo/ui/components/badge';
import { Button, buttonVariants } from '@repo/ui/components/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@repo/ui/components/empty';
import { Field, FieldLabel } from '@repo/ui/components/field';
import { Input } from '@repo/ui/components/input';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@repo/ui/components/select';
import { Skeleton } from '@repo/ui/components/skeleton';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import { cn } from '@repo/ui/lib/utils';
import { ArrowRightIcon, InboxIcon, RefreshCwIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { parseAsString, parseAsStringEnum, useQueryState } from 'nuqs';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LocalTime } from '../../components/local-time';
import { PageFrame } from '../../components/page-frame';
import { PageHeader } from '../../components/page-header';
import { PageSurface } from '../../components/page-surface';
import { Link } from '../../i18n/navigation';
import { loadDecisions } from './decision-api';
import { DecisionDetail } from './decision-detail';

type Bucket = 'attention' | 'progress' | 'later' | 'closed';

const buckets: Bucket[] = ['attention', 'progress', 'later', 'closed'];

function bucket(item: Decision, now: number): Bucket {
  if (item.status === 'applied' || item.status === 'superseded') {
    return 'closed';
  }
  if (item.status === 'awaiting_answer') {
    return item.snoozedUntil && Date.parse(item.snoozedUntil) > now ? 'later' : 'attention';
  }
  return 'progress';
}

export function DecisionWorkspace() {
  const t = useTranslations('decisions');
  const [items, setItems] = useState<Decision[] | null>(null);
  const [error, setError] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [filter, setFilter] = useQueryState(
    'view',
    parseAsStringEnum(buckets).withDefault('attention'),
  );
  const [project, setProject] = useQueryState('project', parseAsString.withDefault('all'));
  const [search, setSearch] = useQueryState('q', parseAsString.withDefault(''));
  const listScrollRef = useRef(0);
  const [selectedId, setSelectedId] = useQueryState('request', parseAsString);
  const refreshSequenceRef = useRef(0);
  const refresh = useCallback(async () => {
    const sequence = ++refreshSequenceRef.current;
    setNow(Date.now());
    try {
      const data = await loadDecisions();
      if (sequence !== refreshSequenceRef.current) {
        return;
      }
      setItems(data);
      setError(false);
    } catch {
      if (sequence === refreshSequenceRef.current) {
        setError(true);
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => {
      if (!document.hidden) {
        void refresh();
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [refresh]);

  const projects = [...new Set((items ?? []).map((item) => item.project))];
  const matching = (items ?? []).filter(
    (item) =>
      (project === 'all' || item.project === project) &&
      `${item.title} ${item.project} ${item.question}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  const visible = matching.filter((item) => bucket(item, now) === filter);
  const selected = selectedId ? items?.find((item) => item.id === selectedId) : visible[0];

  return (
    <PageFrame className="flex flex-col gap-6">
      {selectedId && <h1 className="sr-only lg:hidden">{t('title')}</h1>}
      <PageHeader
        title={t('title')}
        description={t('description')}
        className={selectedId ? 'hidden lg:flex' : undefined}
        actions={
          <>
            <Link
              href="/connections"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              {t('connections')}
            </Link>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refresh();
              }}
            >
              <RefreshCwIcon data-icon="inline-start" />
              {t('refresh')}
            </Button>
          </>
        }
      />
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t('loadError')}</AlertTitle>
          <AlertDescription>
            {t('loadErrorHelp')}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void refresh();
              }}
            >
              {t('refresh')}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {items === null && !error && (
        <div aria-label={t('loading')} className="flex flex-col gap-4">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      )}
      {items !== null && (
        <>
          <div
            className={cn(
              'flex flex-wrap items-center justify-between gap-4',
              selectedId && 'hidden lg:flex',
            )}
          >
            <ToggleGroup
              value={[filter]}
              onValueChange={(value) => {
                if (
                  value[0] === 'attention' ||
                  value[0] === 'progress' ||
                  value[0] === 'later' ||
                  value[0] === 'closed'
                ) {
                  void setFilter(value[0]);
                  void setSelectedId(null);
                }
              }}
              variant="outline"
              aria-label={t('statusFilter')}
              className="flex-wrap"
            >
              {buckets.map((value) => (
                <ToggleGroupItem key={value} value={value}>
                  {t(value)}
                  <span className="tabular-nums">
                    {matching.filter((item) => bucket(item, now) === value).length}
                  </span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select
              value={project}
              onValueChange={(value) => {
                void setProject(value ?? 'all');
                void setSelectedId(null);
              }}
            >
              <SelectTrigger aria-label={t('projectFilter')}>
                <SelectValue>{project === 'all' ? t('allProjects') : project}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="all">{t('allProjects')}</SelectItem>
                  {projects.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
          <PageSurface className="grid min-h-[620px] lg:grid-cols-[19rem_minmax(0,1fr)] 2xl:grid-cols-[22rem_minmax(0,1fr)]">
            <section
              aria-label={t('list')}
              className={cn('min-w-0 border-border lg:border-r', selectedId && 'hidden lg:block')}
            >
              <div className="border-b p-4">
                <Field>
                  <FieldLabel htmlFor="decision-search" className="sr-only">
                    {t('search')}
                  </FieldLabel>
                  <Input
                    id="decision-search"
                    value={search}
                    onChange={(event) => {
                      void setSearch(event.target.value);
                      void setSelectedId(null);
                    }}
                    placeholder={t('search')}
                  />
                </Field>
              </div>
              {visible.length === 0 ? (
                <Empty>
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <InboxIcon />
                    </EmptyMedia>
                    <EmptyTitle>
                      {t(
                        filter === 'attention' && !search && project === 'all'
                          ? 'noAnswersNeeded'
                          : 'emptyTitle',
                      )}
                    </EmptyTitle>
                    <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
              ) : (
                <ul className="divide-y divide-border">
                  {visible.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => {
                          listScrollRef.current = window.scrollY;
                          void setSelectedId(item.id);
                        }}
                        aria-current={selected?.id === item.id ? 'true' : undefined}
                        className={cn(
                          'flex w-full flex-col gap-3 border-l-2 p-5 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                          selected?.id === item.id
                            ? 'border-l-primary bg-accent'
                            : 'border-l-transparent',
                        )}
                      >
                        <span className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-muted-foreground">
                            {item.project}
                          </span>
                          <Badge
                            variant={item.status === 'delivery_failed' ? 'destructive' : 'outline'}
                          >
                            {item.status === 'awaiting_answer'
                              ? t(
                                  bucket(item, now) === 'later'
                                    ? 'later'
                                    : item.answers.length
                                      ? 'returned'
                                      : 'status.awaiting_answer',
                                )
                              : t(`status.${item.status}`)}
                          </Badge>
                        </span>
                        <span className="text-sm leading-6 font-semibold">{item.title}</span>
                        <span className="line-clamp-2 text-xs leading-6 text-muted-foreground">
                          {item.status === 'awaiting_answer'
                            ? item.answers.length
                              ? ([...item.events]
                                  .reverse()
                                  .find((event) => event.kind === 'needs_input')?.text ??
                                item.waitingFor)
                              : `${t('waitingWork')}: ${item.waitingFor}`
                            : t(`explanation.${item.status}`)}
                        </span>
                        <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>
                            {item.status === 'awaiting_answer' && item.mode === 'nonblocking' ? (
                              t('independentWork')
                            ) : (
                              <LocalTime value={item.updatedAt} />
                            )}
                          </span>
                          <ArrowRightIcon className="size-3.5" />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <div
              className={cn('min-w-0', !selectedId && 'hidden lg:block')}
              onFocusCapture={() => {
                if (!selectedId && selected) {
                  void setSelectedId(selected.id);
                }
              }}
            >
              {selected ? (
                <DecisionDetail
                  key={selected.id}
                  item={selected}
                  now={now}
                  onChange={async () => {
                    await setSelectedId(selected.id);
                    await refresh();
                  }}
                  onBack={() => {
                    void setSelectedId(null).then(() =>
                      requestAnimationFrame(() => window.scrollTo({ top: listScrollRef.current })),
                    );
                  }}
                />
              ) : (
                <Empty className="h-full">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <InboxIcon />
                    </EmptyMedia>
                    <EmptyTitle>{selectedId ? t('notFound') : t('selectRequest')}</EmptyTitle>
                    <EmptyDescription>{t('emptyDescription')}</EmptyDescription>
                  </EmptyHeader>
                  {selectedId && (
                    <Button
                      variant="outline"
                      onClick={() => {
                        void setSelectedId(null);
                      }}
                    >
                      {t('back')}
                    </Button>
                  )}
                </Empty>
              )}
            </div>
          </PageSurface>
        </>
      )}
    </PageFrame>
  );
}
