'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

// Without this boundary any throw while rendering the charts takes the whole
// admin shell down to Next's blank "Application error" screen, which is what
// "Reports won't load" looked like from the merchant's side.
export default function ReportsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('reports');

  // The raw message is English and technical: it goes to the console, and the merchant gets
  // the digest, which is what support can match to the server log.
  React.useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="container max-w-6xl py-8">
      <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
      <Card className="mt-5 p-6">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
          <AlertTriangle className="h-5 w-5" /> {t('crash.title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('crash.body')}</p>
        {error.digest ? (
          <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
            {t('crash.reference', { digest: error.digest })}
          </p>
        ) : null}
        <div className="mt-4">
          <Button variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={reset}>
            {t('retry')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
