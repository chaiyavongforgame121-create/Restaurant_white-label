'use client';

import * as React from 'react';
import { Download, ShieldAlert, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

export function AccountView() {
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
        setError(rpcErr.message);
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
    const confirmation = window.prompt(
      'Type DELETE to permanently anonymize your account. This cannot be undone.',
    );
    if (confirmation !== 'DELETE') return;
    setDeleting(true);
    setError(null);
    setInfo(null);
    try {
      const supabase = getBrowserClient();
      const { error: rpcErr } = await supabase.rpc('delete_my_account');
      if (rpcErr) {
        setError(rpcErr.message);
        return;
      }
      await supabase.auth.signOut();
      setInfo('Your account has been anonymized. You will now be signed out.');
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
        <h1 className="font-display text-3xl font-bold">Your account</h1>
        <p className="mt-1 text-muted-foreground">Manage your data and privacy settings.</p>
      </header>

      <Card className="mt-6 space-y-4 p-5">
        <h2 className="font-display text-lg font-semibold">Download your data</h2>
        <p className="text-sm text-muted-foreground">
          Export a copy of everything we have about you — orders, addresses, and account info — as
          a JSON file.
        </p>
        <Button
          variant="outline"
          onClick={exportData}
          loading={exporting}
          leftIcon={<Download className="h-4 w-4" />}
        >
          Download my data (JSON)
        </Button>
      </Card>

      <Card className="mt-4 space-y-4 border-destructive/40 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
          <ShieldAlert className="h-5 w-5" /> Delete my account
        </h2>
        <p className="text-sm text-muted-foreground">
          Permanently anonymize your account. Your order history is retained for tax records, but
          all personal information (name, phone, addresses, loyalty balance) is removed and cannot
          be recovered.
        </p>
        <Button
          variant="ghost"
          onClick={deleteAccount}
          loading={deleting}
          leftIcon={<Trash2 className="h-4 w-4" />}
          className="text-destructive hover:bg-destructive/10"
        >
          Delete account
        </Button>
      </Card>

      {info && <p className="mt-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">{info}</p>}
      {error && <p className="mt-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>}

      <div className="mt-8 flex flex-wrap gap-4 text-xs text-muted-foreground">
        <a className="text-primary underline" href="/privacy">Privacy policy</a>
        <a className="text-primary underline" href="/terms">Terms of service</a>
        <a className="text-primary underline" href="/ccpa">California rights</a>
      </div>
    </main>
  );
}
