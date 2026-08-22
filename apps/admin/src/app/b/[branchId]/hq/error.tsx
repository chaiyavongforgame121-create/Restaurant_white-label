'use client';

import * as React from 'react';
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
  return (
    <div className="container max-w-6xl py-8">
      <h1 className="font-display text-3xl font-bold">Head office</h1>
      <Card className="mt-5 p-6">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
          <AlertTriangle className="h-5 w-5" /> Something broke while drawing this rollup
        </h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Your orders and sales data are untouched. Try again — if it keeps failing, send the
          message below to support.
        </p>
        <p className="mt-3 break-words rounded-xl bg-destructive/10 px-4 py-3 font-mono text-xs text-destructive">
          {error.message || 'Unknown rendering error.'}
          {error.digest ? ` (digest ${error.digest})` : ''}
        </p>
        <div className="mt-4">
          <Button variant="outline" leftIcon={<RefreshCw className="h-4 w-4" />} onClick={reset}>
            Try again
          </Button>
        </div>
      </Card>
    </div>
  );
}
