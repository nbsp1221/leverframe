'use client';

import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@repo/ui/components/sidebar';
import {
  BotIcon,
  GitPullRequestIcon,
  InboxIcon,
  type LucideIcon,
  SettingsIcon,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../i18n/navigation';
import { useSettingsHref } from './connection-settings-link';

const destinations = [
  { href: '/decisions', label: 'decisions', icon: InboxIcon, section: 'primary' },
  { href: '/reviews', label: 'codeReviewBot', icon: GitPullRequestIcon, section: 'primary' },
  { href: '/development', label: 'development', icon: BotIcon, section: 'primary' },
  { href: '/settings', label: 'settings', icon: SettingsIcon, section: 'utility' },
] as const;

export function getWorkspaceDestination(pathname: string) {
  return destinations.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
}

export function WorkspaceNavigation({ section }: { section: 'primary' | 'utility' }) {
  const active = getWorkspaceDestination(usePathname());
  const settingsHref = useSettingsHref();

  return (
    <NavigationMenu
      items={destinations
        .filter((item) => item.section === section)
        .map((item) => ({
          ...item,
          href: item.href === '/settings' ? settingsHref : item.href,
          active: active?.href === item.href,
        }))}
    />
  );
}

export function NavigationMenu({
  items,
}: {
  items: { href: string; label: string; icon: LucideIcon; active?: boolean }[];
}) {
  const t = useTranslations('common');
  const { setOpenMobile } = useSidebar();

  return (
    <SidebarMenu className="gap-1">
      {items.map(({ href, label, icon: Icon, active }) => (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton
            isActive={active ?? false}
            aria-current={active ? 'page' : undefined}
            tooltip={t(label)}
            onClick={() => setOpenMobile(false)}
            className="h-10 rounded-xl px-3 text-sm font-medium data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
            render={<Link href={href} />}
          >
            <Icon aria-hidden="true" />
            <span className="group-data-[collapsible=icon]:sr-only">{t(label)}</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}
