'use client';

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@repo/ui/components/sidebar';
import { BotIcon, GitPullRequestIcon, InboxIcon, MonitorIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../i18n/navigation';

const destinations = [
  { href: '/decisions', label: 'decisions', icon: InboxIcon },
  { href: '/reviews', label: 'codeReviewBot', icon: GitPullRequestIcon },
  { href: '/development', label: 'development', icon: BotIcon },
  { href: '/connections', label: 'connections', icon: MonitorIcon },
] as const;

export function getWorkspaceDestination(pathname: string) {
  return destinations.find(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
}

export function WorkspaceNavigation() {
  const t = useTranslations('common');
  const active = getWorkspaceDestination(usePathname());

  return (
    <SidebarMenu className="gap-1">
      {destinations.map(({ href, label, icon: Icon }) => (
        <SidebarMenuItem key={href}>
          <SidebarMenuButton
            isActive={active?.href === href}
            aria-current={active?.href === href ? 'page' : undefined}
            tooltip={t(label)}
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
