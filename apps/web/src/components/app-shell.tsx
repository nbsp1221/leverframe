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
  SidebarRail,
  SidebarTrigger,
} from '@repo/ui/components/sidebar';
import { ToggleGroup, ToggleGroupItem } from '@repo/ui/components/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@repo/ui/components/tooltip';
import { GitPullRequestIcon, MoonIcon, SunIcon } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { useTheme } from 'next-themes';
import Image from 'next/image';
import { NuqsAdapter } from 'nuqs/adapters/next/app';
import { type CSSProperties, useEffect, useState } from 'react';
import { Link, usePathname, useRouter } from '../i18n/navigation';
import { confirmDirtyNavigation } from '../lib/dirty-navigation';

const shellSize = {
  '--sidebar-width': '13.5rem',
  '--sidebar-width-icon': '3.5rem',
} as CSSProperties;

export function AppShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <TooltipProvider delay={250}>
      <NuqsAdapter>
        <SidebarProvider defaultOpen style={shellSize}>
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
      className="border-sidebar-border/80"
    >
      <SidebarHeader className="h-16 justify-center border-b border-sidebar-border/70 px-3 py-0 group-data-[collapsible=icon]:px-2">
        <Link
          href="/reviews"
          className="flex h-10 items-center gap-3 overflow-hidden rounded-xl px-2 outline-none transition-colors hover:bg-sidebar-accent/70 focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
        >
          <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-lg bg-primary shadow-sm shadow-primary/10">
            <Image
              src="/brand/leverframe-mark-on-blue.svg"
              alt=""
              width={18}
              height={18}
              loading="eager"
              aria-hidden="true"
            />
          </span>
          <span className="truncate text-base font-semibold tracking-[-0.02em] group-data-[collapsible=icon]:hidden">
            {t('brand')}
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent className="px-2 py-3">
        <SidebarGroup className="p-0">
          <SidebarGroupLabel className="mb-1 px-3 text-xs font-medium text-muted-foreground group-data-[collapsible=icon]:hidden">
            {t('workspace')}
          </SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu className="gap-1">
              <SidebarMenuItem>
                <SidebarMenuButton
                  isActive={pathname.endsWith('/reviews')}
                  tooltip={t('codeReviewBot')}
                  className="h-10 rounded-xl px-3 text-sm font-medium data-active:bg-sidebar-primary data-active:text-sidebar-primary-foreground group-data-[collapsible=icon]:size-10! group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0!"
                  render={<Link href="/reviews" />}
                >
                  <GitPullRequestIcon aria-hidden="true" className="size-4.5" />
                  <span>{t('codeReviewBot')}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarRail />
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
      <header className="sticky top-0 z-20 flex h-16 items-center border-b border-border/80 bg-background/90 px-3 backdrop-blur-xl sm:px-5">
        <SidebarTrigger
          aria-label={t('openMenu')}
          className="mr-2 size-9 rounded-xl text-muted-foreground hover:bg-surface hover:text-foreground"
        />

        <Breadcrumb aria-label={t('breadcrumb')} className="min-w-0 flex-1">
          <BreadcrumbList className="flex-nowrap overflow-hidden text-sm">
            <BreadcrumbItem className="hidden sm:flex">
              <BreadcrumbLink
                className="font-medium text-muted-foreground transition-colors hover:text-foreground"
                render={<Link href="/reviews" />}
              >
                {t('codeReviewBot')}
              </BreadcrumbLink>
            </BreadcrumbItem>
            <BreadcrumbSeparator className="hidden sm:flex" />
            <BreadcrumbItem>
              <BreadcrumbPage className="font-semibold text-foreground">
                {t('reviews')}
              </BreadcrumbPage>
            </BreadcrumbItem>
          </BreadcrumbList>
        </Breadcrumb>

        <div className="flex shrink-0 items-center gap-1.5">
          <ToggleGroup
            aria-label={t('language')}
            value={[locale]}
            onValueChange={(value) => changeLocale(value[0] ?? locale)}
            variant="default"
            size="sm"
            spacing={0}
            className="rounded-xl bg-surface-subtle p-0.5"
          >
            <ToggleGroupItem
              value="en"
              aria-label={t('english')}
              className="h-7 min-w-9 rounded-lg border-0 px-2 text-xs font-medium text-muted-foreground shadow-none data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              EN
            </ToggleGroupItem>
            <ToggleGroupItem
              value="ko"
              aria-label={t('korean')}
              className="h-7 min-w-9 rounded-lg border-0 px-2 text-xs font-medium text-muted-foreground shadow-none data-[state=on]:bg-surface data-[state=on]:text-foreground data-[state=on]:shadow-sm"
            >
              KO
            </ToggleGroupItem>
          </ToggleGroup>

          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 rounded-xl text-muted-foreground hover:bg-surface hover:text-foreground"
                  aria-label={isDark ? t('lightTheme') : t('darkTheme')}
                  onClick={() => setTheme(isDark ? 'light' : 'dark')}
                />
              }
            >
              {isDark ? (
                <SunIcon aria-hidden="true" className="size-4" />
              ) : (
                <MoonIcon aria-hidden="true" className="size-4" />
              )}
            </TooltipTrigger>
            <TooltipContent>{isDark ? t('lightTheme') : t('darkTheme')}</TooltipContent>
          </Tooltip>
        </div>
      </header>

      <main className="w-full flex-1 px-4 py-7 sm:px-6 lg:px-8 lg:py-9">{children}</main>
    </div>
  );
}
