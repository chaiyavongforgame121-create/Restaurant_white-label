'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bell, Check, Plus, UserX } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface Party {
  id: string;
  party_name: string;
  party_size: number;
  phone: string | null;
  notes: string | null;
  status: 'waiting' | 'notified' | 'seated' | 'no_show' | 'canceled';
  position: number | null;
  added_at: string;
  notified_at: string | null;
  seated_at: string | null;
}

interface Props {
  branchId: string;
  initial: Party[];
}

export function WaitlistView({ branchId, initial }: Props) {
  const router = useRouter();
  const [parties, setParties] = React.useState(initial);
  const [adding, setAdding] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refetch = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('waitlist')
      .select('id, party_name, party_size, phone, notes, status, position, added_at, notified_at, seated_at')
      .eq('branch_id', branchId)
      .order('added_at', { ascending: false });
    setParties((data ?? []) as Party[]);
  };

  const active = parties.filter((p) => p.status === 'waiting' || p.status === 'notified');
  const history = parties.filter((p) => p.status !== 'waiting' && p.status !== 'notified').slice(0, 10);

  const setStatus = async (id: string, status: Party['status']) => {
    const supabase = getBrowserClient();
    const patch: Partial<Party> = { status };
    if (status === 'seated') patch.seated_at = new Date().toISOString();
    const { error: upErr } = await supabase.from('waitlist').update(patch).eq('id', id);
    if (upErr) { setError(upErr.message); return; }
    refetch();
  };

  const notify = async (id: string) => {
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('notify_waitlist_party', { p_id: id });
    if (rpcErr) { setError(rpcErr.message); return; }
    refetch();
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Waitlist</h1>
          <p className="mt-1 text-muted-foreground">
            {active.length} party{active.length === 1 ? '' : 'ies'} waiting · text them when a table is ready.
          </p>
        </div>
        <Button variant="gradient" onClick={() => setAdding(true)} leftIcon={<Plus className="h-4 w-4" />}>
          Add to waitlist
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {active.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">No one waiting right now.</Card>
      ) : (
        <ul className="space-y-2">
          {active.sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).map((p) => (
            <li key={p.id}>
              <Card className="flex items-center justify-between gap-4 p-4">
                <div className="flex items-center gap-3">
                  <span className="grid h-12 w-12 place-items-center rounded-2xl bg-primary/10 text-primary font-display text-lg font-bold">
                    {p.position ?? '?'}
                  </span>
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="font-display text-base font-bold">{p.party_name}</p>
                      <Badge variant="muted">{p.party_size} ppl</Badge>
                      {p.status === 'notified' && <Badge variant="warning">Notified</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Added {new Date(p.added_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      {p.phone && ` · ${p.phone}`}
                      {p.notes && ` · ${p.notes}`}
                    </p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {p.status === 'waiting' && p.phone && (
                    <Button size="sm" variant="outline" onClick={() => notify(p.id)} leftIcon={<Bell className="h-3.5 w-3.5" />}>
                      Notify
                    </Button>
                  )}
                  <Button size="sm" variant="gradient" onClick={() => setStatus(p.id, 'seated')} leftIcon={<Check className="h-3.5 w-3.5" />}>
                    Seat
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setStatus(p.id, 'no_show')} leftIcon={<UserX className="h-3.5 w-3.5" />}>
                    No-show
                  </Button>
                </div>
              </Card>
            </li>
          ))}
        </ul>
      )}

      {history.length > 0 && (
        <Card className="mt-8 p-5">
          <h2 className="font-display text-lg font-semibold">Recent activity</h2>
          <ul className="mt-3 space-y-1 text-sm">
            {history.map((p) => (
              <li key={p.id} className="flex items-center justify-between border-b border-border/40 pb-1 last:border-0">
                <span>
                  <strong>{p.party_name}</strong>{' '}
                  <Badge variant="muted">{p.status.replace('_', ' ')}</Badge>
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(p.seated_at ?? p.added_at).toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {adding && (
        <AddPartyDialog
          branchId={branchId}
          onClose={() => setAdding(false)}
          onAdded={() => { setAdding(false); refetch(); router.refresh(); }}
        />
      )}
    </div>
  );
}

function AddPartyDialog({ branchId, onClose, onAdded }: { branchId: string; onClose: () => void; onAdded: () => void }) {
  const [name, setName] = React.useState('');
  const [size, setSize] = React.useState('2');
  const [phone, setPhone] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    if (!name) { setError('Party name required'); return; }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('waitlist').insert({
      branch_id: branchId,
      party_name: name,
      party_size: Number(size) || 1,
      phone: phone || null,
      notes: notes || null,
    });
    setBusy(false);
    if (insErr) { setError(insErr.message); return; }
    onAdded();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card className="w-full max-w-md space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="font-display text-lg font-semibold">Add to waitlist</h2>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Party name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" autoFocus />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Party size</span>
            <input type="number" min={1} max={50} value={size} onChange={(e) => setSize(e.target.value)} className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Phone (optional)</span>
            <input value={phone} onChange={(e) => setPhone(e.target.value)} type="tel" placeholder="(555) 234-5678" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
          </label>
        </div>
        <label className="block">
          <span className="mb-1 block text-sm font-medium">Notes (optional)</span>
          <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Booth preferred, high chair…" className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm" />
        </label>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="gradient" onClick={submit} loading={busy}>Add</Button>
        </div>
      </Card>
    </div>
  );
}
