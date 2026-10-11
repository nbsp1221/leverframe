'use client';

import { buttonVariants } from '@repo/ui/components/button';
import { useTranslations } from 'next-intl';
import { Link, usePathname } from '../i18n/navigation';
import { useSettingsHref } from './connection-settings-link';

export function SettingsNavigation() {
  const t = useTranslations('common');
  const pathname = usePathname();
  const reviews = useSettingsHref('reviews');
  const connections = useSettingsHref('connections');
  return (
    <nav aria-label={t('settings')} className="flex flex-wrap gap-1 border-b border-border pb-3">
      {[
        { href: reviews, path: '/settings/reviews', label: 'codeReviewBot' },
        { href: connections, path: '/settings/connections', label: 'connections' },
      ].map((item) => (
        <Link
          key={item.path}
          href={item.href}
          aria-current={pathname === item.path ? 'page' : undefined}
          className={buttonVariants({
            variant: pathname === item.path ? 'secondary' : 'ghost',
            size: 'sm',
          })}
        >
          {t(item.label)}
        </Link>
      ))}
    </nav>
  );
}
