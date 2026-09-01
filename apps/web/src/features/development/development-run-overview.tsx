'use client';

import type { DevelopmentRunDetail } from '@repo/contracts';
import { Badge } from '@repo/ui/components/badge';
import { Button } from '@repo/ui/components/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@repo/ui/components/collapsible';
import { Separator } from '@repo/ui/components/separator';
import { useTranslations } from 'next-intl';
import { type ReactNode, useState } from 'react';
import { DevelopmentWorkflowOverview } from './development-run-presentation';

export function DevelopmentRunOverview({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  return (
    <div className="flex flex-col">
      <GoalOverview goal={detail.run.goal} />
      <Separator />
      <OverviewSection title={t('overview')}>
        <OverviewRow label={t('repository')} value={detail.run.repository} />
        <OverviewRow label={t('status')} value={t(`phase_${detail.run.phase}`)} />
        <OverviewRow label={t('run')} value={`#${detail.run.id}`} />
        <OverviewRow
          label={t('lastActivity')}
          value={<OverviewDate value={detail.run.last_activity_at} />}
        />
      </OverviewSection>
      <Separator />
      <DevelopmentWorkflowOverview detail={detail} />
      <Separator />
      <EvidenceOverview detail={detail} />
      <Separator />
      <ResourcesOverview detail={detail} />
      {detail.external_source === null ? null : (
        <>
          <Separator />
          <ExternalOverview detail={detail} />
        </>
      )}
    </div>
  );
}

function GoalOverview({ goal }: { goal: string }) {
  const t = useTranslations('development');
  const [open, setOpen] = useState(false);
  const needsDisclosure = goal.length > 240 || goal.split('\n').length > 4;

  if (!needsDisclosure) {
    return (
      <OverviewSection title={t('goal')}>
        <p className="whitespace-pre-wrap text-sm leading-5">{goal}</p>
      </OverviewSection>
    );
  }

  return (
    <OverviewSection title={t('goal')}>
      <Collapsible open={open} onOpenChange={setOpen}>
        {open ? null : <p className="line-clamp-4 text-sm leading-5">{goal}</p>}
        <CollapsibleContent>
          <p className="whitespace-pre-wrap text-sm leading-5">{goal}</p>
        </CollapsibleContent>
        <CollapsibleTrigger
          render={<Button type="button" variant="link" size="sm" className="px-0" />}
        >
          {open ? t('showLess') : t('showFullGoal')}
        </CollapsibleTrigger>
      </Collapsible>
    </OverviewSection>
  );
}

function OverviewSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5 px-2 py-2.5">
      <h2 className="px-2 text-xs font-medium text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}

function OverviewRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-2 px-2 py-1.5 text-sm">
      <span>{label}</span>
      <span
        className="max-w-[45%] truncate text-right text-xs text-muted-foreground"
        title={typeof value === 'string' ? value : undefined}
      >
        {value}
      </span>
    </div>
  );
}

function OverviewDate({ value }: { value: string }) {
  const t = useTranslations('development');
  const relative = formatRelativeTime(value);
  return <span title={value}>{t(relative.key, relative.values)}</span>;
}

function formatRelativeTime(value: string): {
  key: 'timeNow' | 'timeMinutes' | 'timeHours' | 'timeDays';
  values?: { count: number };
} {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) {
    return { key: 'timeNow' };
  }
  if (minutes < 60) {
    return { key: 'timeMinutes', values: { count: minutes } };
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return { key: 'timeHours', values: { count: hours } };
  }
  return { key: 'timeDays', values: { count: Math.floor(hours / 24) } };
}

function EvidenceOverview({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  return (
    <OverviewSection title={t('evidence')}>
      {detail.evidence.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('noEvidence')}</p>
      ) : (
        detail.evidence.map((evidence) => (
          <Collapsible key={evidence.id}>
            <CollapsibleTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-between px-2 py-1.5"
                />
              }
            >
              <span className="truncate text-left">{evidence.criterion}</span>
              <Badge
                variant={
                  evidence.verdict === 'failed'
                    ? 'destructive'
                    : evidence.verdict === 'passed'
                      ? 'secondary'
                      : 'outline'
                }
              >
                {t(`verdict_${evidence.verdict}`)}
              </Badge>
            </CollapsibleTrigger>
            <CollapsibleContent className="px-2 pb-2 text-xs leading-5 text-muted-foreground">
              {evidence.observation}
            </CollapsibleContent>
          </Collapsible>
        ))
      )}
    </OverviewSection>
  );
}

function ResourcesOverview({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  return (
    <OverviewSection title={t('resources')}>
      {detail.resources.length === 0 ? (
        <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('noResources')}</p>
      ) : (
        detail.resources.map((resource) => (
          <div
            key={resource.kind}
            className="flex min-w-0 items-center justify-between gap-2 px-2 py-1.5"
          >
            <span className="min-w-0">
              <span className="block text-sm">{t(`resource_${resource.kind}`)}</span>
              <span
                className="block truncate text-xs text-muted-foreground"
                title={resource.external_id}
              >
                {resource.external_id}
              </span>
            </span>
            <Badge variant={resource.state === 'cleanup_failed' ? 'destructive' : 'outline'}>
              {t(`resourceState_${resource.state}`)}
            </Badge>
          </div>
        ))
      )}
    </OverviewSection>
  );
}

function ExternalOverview({ detail }: { detail: DevelopmentRunDetail }) {
  const t = useTranslations('development');
  if (detail.external_source === null) {
    return null;
  }
  const identity = detail.external_source.key ?? detail.external_source.id;
  return (
    <OverviewSection title={t('externalSource')}>
      <OverviewRow
        label={detail.external_source.provider}
        value={
          detail.external_source.url === null ? (
            identity
          ) : (
            <a
              href={detail.external_source.url}
              rel="noreferrer"
              target="_blank"
              className="underline-offset-4 hover:underline"
            >
              {identity}
            </a>
          )
        }
      />
      <OverviewRow
        label={t('externalSync')}
        value={
          detail.external_sync === null
            ? t('externalSyncPending')
            : t(`externalSyncState_${detail.external_sync.state}`)
        }
      />
    </OverviewSection>
  );
}
