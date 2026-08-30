'use client';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@repo/ui/components/breadcrumb';
import { Button } from '@repo/ui/components/button';
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from '@repo/ui/components/sidebar';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@repo/ui/components/tooltip';
import { BotIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import Image from 'next/image';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { useEffect, useState } from 'react';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { confirmDirtyNavigation } from '../lib/dirty-navigation';

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <TooltipProvider>
      <NuqsAdapter>
        <SidebarProvider defaultOpen>
          <AppSidebar />
          <SidebarMain>{children}</SidebarMain>
        </SidebarProvider>
      </NuqsAdapter>
    </TooltipProvider>
  );
}

function AppSidebar() {
  const t = useTranslations('common');
  const pathname = usePathname();

  return (
    <Sidebar
      collapsible="icon"
      mobileTitle={t('sidebarTitle')}
      mobileDescription={t('sidebarDescription')}
    >
      <SidebarHeader className="gap-3 border-b border-sidebar-border p-3">
        <Link
          href="/reviews"
          className="flex items-center gap-2 overflow-hidden rounded-md px-1 py-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Image
            src="/brand/leverframe-mark-on-white.svg"
            alt=""
            width={20}
            height={20}
            className="dark:hidden"
            aria-hidden="true"
          />
          <Image
            src="/brand/leverframe-mark-on-blue.svg"
            alt=""
            width={20}
            height={20}
            className="hidden dark:block"
            aria-hidden="true"
          />
          <span className="truncate text-sm font-semibold">{t('brand')}</span>
        </Link>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t('workspace')}</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.endsWith('/reviews')}
                  render={<Link href="/reviews" />}
                >
                  <Image
                    src="/brand/leverframe-mark-on-white.svg"
                    alt=""
                    width={20}
                    height={20}
                    className="dark:hidden"
                    aria-hidden="true"
                  />
                  <Image
                    src="/brand/leverframe-mark-on-blue.svg"
                    alt=""
                    width={20}
                    height={20}
                    className="hidden dark:block"
                    aria-hidden="true"
                  />
                  <span>{t('codeReviewBot')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.includes('/development')}
                  render={<Link href="/development" />}
                >
                  <BotIcon aria-hidden="true" />
                  <span>{t('development')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
    </Sidebar>
  );
}

function SidebarMain({ children }: Readonly<{ children: React.ReactNode }>) {
  const t = useTranslations('common');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const { resolvedTheme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);

  // Theme controls must wait for the client preference to avoid hydration mismatch.
  // eslint-disable-next-line @eslint-react/set-state-in-effect
  useEffect(() => setMounted(true), []);

  function changeLocale(nextLocale: string) {
    if (nextLocale !== 'en' && nextLocale !== 'ko') {
      return;
    }
    if (!confirmDirtyNavigation()) {
      return;
    }
    document.cookie = `NEXT_LOCALE=${nextLocale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    router.replace(
      {
        pathname,
        query: Object.fromEntries(new URLSearchParams(window.location.search).entries()),
      },
      { locale: nextLocale },
    );
  }

  const isDark = mounted && resolvedTheme === 'dark';

  return (
    <div className="flex min-h-svh min-w-0 flex-1 flex-col bg-background">
      <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:px-6">
        <SidebarTrigger aria-label={t('openMenu')} />
        <Breadcrumb aria-label={t('breadcrumb')} className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap overflow-hidden">
            <BreadcrumbItem>
              <BreadcrumbLink render={<Link href="/reviews" />}>
                {t('codeReviewBot')}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator />
            <BreadcrumbItem>
              <BreadcrumbPage>{t('reviews')}</BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleGroup
            aria-label={t('language')}
            value={[locale]}
            onValueChange={(value) => changeLocale(value[0] ?? locale)}
            variant="outline"
            size="sm"
          >
            <ToggleGroupItem value="en" aria-label={t('english')}>
              EN
            </ToggleGroupItem>
            <ToggleGroupItem value="ko" aria-label={t('korean')}>
              KO
            </ToggleGroupItem>
          </ToggleGroup>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={isDark ? t('lightTheme') : t('darkTheme')}
                  onClick={() => setTheme(isDark ? 'light' : 'dark')}
                />
              }
            >
              {isDark ? (
                <SunIcon data-icon="inline-start" aria-hidden="true" />
              ) : (
                <MoonIcon data-icon="inline-start" aria-hidden="true" />
              )}
            </TooltipTrigger>
            <TooltipContent>{isDark ? t('lightTheme') : t('darkTheme')}</TooltipContent>
          </Tooltip>
        </div>
      </header>
      <main className="w-full flex-1 px-4 py-6 sm:px-6 lg:px-8">{children}</main>
    </div>
  );
}
