'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarX, Plus, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, IconButton } from '@favornoms/ui';

interface Closure {
  id: string;
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export function ClosuresManager({ branchId }: { branchId: string }) {
  const router = useRouter();
  const [list, setList] = React.useState<Closure[]>([]);
  const [composing, setComposing] = React.useState(false);
  const [startsAt, setStartsAt] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void refresh();
  }, [branchId]);

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('branch_closures')
      .select('id, starts_at, ends_at, reason')
      .eq('branch_id', branchId)
      .order('starts_at', { ascending: false });
    if (data) setList(data as Closure[]);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('branch_closures').insert({
      branch_id: branchId,
      starts_at: startsAt,
      ends_at: endsAt,
      reason: reason || null,
    });
    setBusy(false);
    if (insErr) { setError(insErr.message); return; }
    setStartsAt(''); setEndsAt(''); setReason(''); setComposing(false);
    await refresh();
    router.refresh();
  };

  const remove = async (id: string) => {
    if (!confirm('Remove this closure?')) return;
    const supabase = getBrowserClient();
    await supabase.from('branch_closures').delete().eq('id', id);
    await refresh();
  };

  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-display text-lg font-semibold">Holiday hours / Closures</h2>
          <p className="text-sm text-muted-foreground">Block ordering during these periods.</p>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? 'ghost' : 'soft'} size="md" leftIcon={<Plus className="h-4 w-4" />}>
          {composing ? 'Cancel' : 'Add closure'}
        </Button>
      </div>

      {composing && (
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="block sm:col-span-1">
            <span className="mb-1.5 block text-sm font-medium">Starts</span>
            <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className="input" />
          </label>
          <label className="block sm:col-span-1">
            <span className="mb-1.5 block text-sm font-medium">Ends</span>
            <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className="input" />
          </label>
          <label className="block sm:col-span-2">
            <span className="mb-1.5 block text-sm font-medium">Reason</span>
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Songkran holiday" className="input" />
          </label>
          {error && <p className="sm:col-span-2 rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button onClick={create} variant="gradient" loading={busy} disabled={!startsAt || !endsAt} className="sm:col-span-2">
            Create
          </Button>
        </div>
      )}

      <ul className="mt-3 divide-y divide-border/40">
        {list.length === 0 && (
          <li className="py-6 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <CalendarX className="h-6 w-6" /> No upcoming closures.
          </li>
        )}
        {list.map((c) => (
          <li key={c.id} className="flex items-center justify-between py-2">
            <div>
              <p className="font-medium">
                {new Date(c.starts_at).toLocaleString()} → {new Date(c.ends_at).toLocaleString()}
              </p>
              {c.reason && <p className="text-xs text-muted-foreground">{c.reason}</p>}
            </div>
            <IconButton label="Delete" size="sm" className="text-danger" onClick={() => remove(c.id)}>
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </li>
        ))}
      </ul>

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </Card>
  );
}
