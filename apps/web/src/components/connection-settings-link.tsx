'use client';

import type { ReactNode } from 'react';
import { buttonVariants } from '@repo/ui/components/button';
import { ArrowLeftIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useSearchParams } from 'next/navigation';
import { Link, usePathname } from '../i18n/navigation';
import { settingsHref, settingsReturnPath } from '../lib/settings-navigation';

export function useSettingsHref(section: 'reviews' | 'connections' = 'reviews') {
  const pathname = usePathname();
  const params = useSearchParams();
  const search = params.toString();
  if (pathname.startsWith('/settings')) {
    return settingsHref(section, settingsReturnPath(params.get('returnTo')));
  }
  return settingsHref(section, `${pathname}${search ? `?${search}` : ''}`);
}

export function ConnectionSettingsLink({ children }: { children: ReactNode }) {
  const href = useSettingsHref('connections');
  return (
    <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {children}
    </Link>
  );
}

export function ReviewSettingsLink({ children }: { children: ReactNode }) {
  const href = useSettingsHref('reviews');
  return (
    <Link href={href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {children}
    </Link>
  );
}

export function SettingsReturnLink() {
  const t = useTranslations('common');
  const href = settingsReturnPath(useSearchParams().get('returnTo'));
  return (
    <Link href={href} className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
      <ArrowLeftIcon data-icon="inline-start" />
      {t('backToWork')}
    </Link>
  );
}
