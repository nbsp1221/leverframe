import type { ReactNode } from 'react';
import { SettingsReturnLink } from '../../../src/components/connection-settings-link';
import { PageFrame } from '../../../src/components/page-frame';
import { SettingsNavigation } from '../../../src/components/settings-navigation';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col gap-6">
      <PageFrame className="flex flex-col items-start gap-4">
        <SettingsReturnLink />
        <div className="w-full">
          <SettingsNavigation />
        </div>
      </PageFrame>
      {children}
    </div>
  );
}
