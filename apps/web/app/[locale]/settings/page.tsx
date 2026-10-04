import { redirect } from '../../../src/i18n/navigation';
import { connectionSettingsHref } from '../../../src/lib/settings-navigation';

export default async function SettingsRedirect({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ returnTo?: string | string[] }>;
}) {
  const { locale } = await params;
  const { returnTo } = await searchParams;
  redirect({
    href: connectionSettingsHref(typeof returnTo === 'string' ? returnTo : '/decisions'),
    locale,
  });
}
