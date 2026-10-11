'use client';

import { Sidebar, SidebarContent, SidebarGroup, SidebarHeader } from '@repo/ui/components/sidebar';
import { ArrowLeftIcon, ChevronRightIcon, GitPullRequestIcon, MonitorIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, usePathname } from '../i18n/navigation';
import { settingsHref, settingsReturnPath } from '../lib/settings-navigation';
import { PageFrame } from './page-frame';
import { PageHeader } from './page-header';
import { PageSurface } from './page-surface';
import { NavigationMenu } from './workspace-navigation';

const sections = [
  {
    section: 'reviews',
    label: 'codeReviewBot',
    description: 'reviewDescription',
    icon: GitPullRequestIcon,
  },
  {
    section: 'connections',
    label: 'connections',
    description: 'connectionsDescription',
    icon: MonitorIcon,
  },
] as const;

export function SettingsSidebar() {
  const t = useTranslations('common');
  const pathname = usePathname();
  const returnTo = settingsReturnPath(useSearchParams().get('returnTo'));
  return (
    <Sidebar
      collapsible="none"
      mobileTitle={t('settings')}
      mobileDescription={t('settingsDescription')}
      className="sticky top-0 hidden h-svh shrink-0 border-r border-sidebar-border md:flex"
    >
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border/70 px-2 py-0">
        <NavigationMenu items={[{ href: returnTo, label: 'backToWork', icon: ArrowLeftIcon }]} />
      </SidebarHeader>
      <SidebarContent className="px-2 py-3">
        <SidebarGroup className="gap-3 p-0">
          <h2 className="px-3 text-sm font-semibold">{t('settings')}</h2>
          <nav aria-label={t('settings')}>
            <NavigationMenu
              items={sections.map((item) => ({
                ...item,
                href: settingsHref(item.section, returnTo),
                active: pathname === `/settings/${item.section}`,
              }))}
            />
          </nav>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

export function SettingsIndex() {
  const t = useTranslations('common');
  const returnTo = settingsReturnPath(useSearchParams().get('returnTo'));
  return (
    <PageFrame className="flex flex-col gap-6">
      <PageHeader title={t('settings')} description={t('settingsDescription')} />
      <PageSurface className="max-w-3xl">
        <nav aria-label={t('settingsCategories')}>
          <ul className="divide-y divide-border">
            {sections.map(({ section, label, description, icon: Icon }) => (
              <li key={section}>
                <Link
                  href={settingsHref(section, returnTo)}
                  className="flex min-h-24 items-center gap-4 px-5 py-5 outline-none transition-colors hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-6"
                >
                  <Icon className="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm font-medium">{t(label)}</span>
                    <span className="text-sm leading-6 text-muted-foreground">
                      {t(description)}
                    </span>
                  </div>
                  <ChevronRightIcon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </PageSurface>
    </PageFrame>
  );
}
