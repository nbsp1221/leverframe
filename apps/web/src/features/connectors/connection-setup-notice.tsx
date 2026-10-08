'use client';

import { Alert, AlertDescription, AlertTitle } from '@repo/ui/components/alert';
import { Button } from '@repo/ui/components/button';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { ConnectionSettingsLink } from '../../components/connection-settings-link';
import { loadConnectors } from './connector-api';

export function ConnectionSetupNotice({ className }: { className?: string | undefined }) {
  const t = useTranslations('connectors');
  const [state, setState] = useState<'loading' | 'configured' | 'empty' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void loadConnectors()
      .then((items) => {
        if (active) {
          setState(items.some((item) => item.status !== 'revoked') ? 'configured' : 'empty');
        }
      })
      .catch(() => {
        if (active) {
          setState('error');
        }
      });
    return () => {
      active = false;
    };
  }, [attempt]);

  if (state === 'loading' || state === 'configured') {
    return null;
  }
  return (
    <Alert className={className}>
      <AlertTitle>
        {t(state === 'empty' ? 'firstConnectionTitle' : 'connectionCheckFailed')}
      </AlertTitle>
      <AlertDescription>
        <p>{t(state === 'empty' ? 'firstConnectionHelp' : 'connectionCheckHelp')}</p>
        <div className="flex flex-wrap gap-2">
          <ConnectionSettingsLink>
            {t(state === 'empty' ? 'add' : 'openSettings')}
          </ConnectionSettingsLink>
          {state === 'error' && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setState('loading');
                setAttempt((value) => value + 1);
              }}
            >
              {t('retry')}
            </Button>
          )}
        </div>
      </AlertDescription>
    </Alert>
  );
}
