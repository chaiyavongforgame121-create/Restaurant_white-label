'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Download, ShieldAlert, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

/** What the person must type to confirm deletion. Compared below, so it is never translated. */
const DELETE_CONFIRMATION_WORD = 'DELETE';

export function AccountView() {
  const t = useTranslations('help.account');
  const [exporting, setExporting] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [info, setInfo] = React.useState<string | null>(null);

  const exportData = async () => {
    setExporting(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { data, error: rpcErr } = await supabase.rpc('export_my_data');
      if (rpcErr) {
        // The server's own wording is not shown to the person; keep it for debugging.
        console.error('export_my_data failed', rpcErr);
        setError(t('export.failed'));
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `favornoms-data-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } finally {
      setExporting(false);
    }
  };

  const deleteAccount = async () => {
    const confirmation = window.prompt(t('delete.prompt', { word: DELETE_CONFIRMATION_WORD }));
    if (confirmation !== DELETE_CONFIRMATION_WORD) return;
    setDeleting(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = getBrowserClient();
      const { error: rpcErr } = await supabase.rpc('delete_my_account');
      if (rpcErr) {
        console.error('delete_my_account failed', rpcErr);
        setError(t('delete.failed'));
        return;
      }
      await supabase.auth.signOut();
      setInfo(t('delete.done'));
      setTimeout(() => {
        window.location.href = '/';
      }, 2500);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <main className="container max-w-2xl py-10">
      <header>
        <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
      </header>

      <Card className="mt-6 space-y-4 p-5">
        <h2 className="font-display text-lg font-semibold">{t('export.title')}</h2>
        <p className="text-sm text-muted-foreground">
          {t('export.body')}
        </p>
        <Button
          variant="outline"
          onClick={exportData}
          loading={exporting}
          leftIcon={<Download className="h-4 w-4" />}
        >
          {t('export.button')}
        </Button>
      </Card>

      <Card className="mt-4 space-y-4 border-destructive/40 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
          <ShieldAlert className="h-5 w-5" /> {t('delete.title')}
        </h2>
        <p className="text-sm text-muted-foreground">
          {t('delete.body')}
        </p>
        <Button
          variant="ghost"
          onClick={deleteAccount}
          loading={deleting}
          leftIcon={<Trash2 className="h-4 w-4" />}
          className="text-destructive hover:bg-destructive/10"
        >
          {t('delete.button')}
        </Button>
      </Card>

      {info && <p className="mt-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">{info}</p>}
      {error && <p className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      {/* The pages themselves stay in English; only the link labels follow the interface. */}
      <div className="mt-8 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <a className="text-primary underline" href="/privacy">{t('links.privacy')}</a>
        <a className="text-primary underline" href="/terms">{t('links.terms')}</a>
        <a className="text-primary underline" href="/ccpa">{t('links.ccpa')}</a>
      </div>
    </main>
  );
}
