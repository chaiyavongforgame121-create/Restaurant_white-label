'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

// Same reasoning as the Reports boundary: a throw inside recharts would
// otherwise replace the whole admin shell with Next's blank "Application
// error" page, and the merchant reports that as "head office is broken".
export default function HqError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('hq');

  // The raw rendering error is for the console; the merchant gets a translated explanation
  // plus the digest, which is what support can look up in the server logs.
  React.useEffect(() => {
    console.error('Head office render failed', error);
  }, [error]);

  return (
    <div className="container max-w-6xl py-8">
      <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
      <Card className="mt-5 p-6">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
          <AlertTriangle className="h-5 w-5" /> {t('errorBoundary.title')}
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">{t('errorBoundary.body')}</p>
        {error.digest && (
          <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
            {t('errorBoundary.reference', { digest: error.digest })}
          </p>
        )}
        <div className="mt-4">
          <Button variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={reset}>
            {t('tryAgain')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
