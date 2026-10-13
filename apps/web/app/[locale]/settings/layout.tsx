'use client';

import type { ReactNode } from 'react';
import {
  SettingsIndexLink,
  SettingsReturnLink,
} from '../../../src/components/connection-settings-link';
import { PageFrame } from '../../../src/components/page-frame';
import { usePathname } from '../../../src/i18n/navigation';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const isIndex = usePathname() === '/settings';
  return (
    <div className="flex flex-col gap-6">
      <PageFrame className="md:hidden">
        {isIndex ? <SettingsReturnLink /> : <SettingsIndexLink />}
      </PageFrame>
      {children}
    </div>
  );
}
