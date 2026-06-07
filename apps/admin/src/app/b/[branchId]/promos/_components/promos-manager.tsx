'use client';

import * as React from 'react';
import { Plus, Tag, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, EmptyState, IconButton } from '@favornoms/ui';

interface Promo {
  id: string;
  branch_id: string;
  code: string;
  kind: 'percent_off' | 'fixed_off' | 'free_delivery';
  value: number;
  min_subtotal: number;
  max_redemptions: number | null;
  redemption_count: number;
  per_customer_limit: number;
  starts_at: string;
  ends_at: string | null;
  is_active: boolean;
}

export function PromosManager({ branchId, initialPromos }: { branchId: string; initialPromos: Promo[] }) {
  const [list, setList] = React.useState(initialPromos);
  const [composing, setComposing] = React.useState(false);
  const [code, setCode] = React.useState('');
  const [kind, setKind] = React.useState<Promo['kind']>('percent_off');
  const [value, setValue] = React.useState('10');
  const [minSubtotal, setMinSubtotal] = React.useState('0');
  const [maxRedemptions, setMaxRedemptions] = React.useState('');
  const [endsAt, setEndsAt] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase.from('promos').select('*').eq('branch_id', branchId).order('created_at', { ascending: false });
    if (data) setList(data as Promo[]);
  };

  const create = async () => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('promos').insert({
      branch_id: branchId,
      code: code.trim().toUpperCase(),
      kind,
      value: Number(value),
      min_subtotal: Number(minSubtotal) || 0,
      max_redemptions: maxRedemptions ? Number(maxRedemptions) : null,
      ends_at: endsAt || null,
    });
    setBusy(false);
    if (insErr) { setError(insErr.message); return; }
    setCode(''); setValue('10'); setMinSubtotal('0'); setMaxRedemptions(''); setEndsAt('');
    setComposing(false);
    void refresh();
  };

  const toggleActive = async (p: Promo) => {
    const supabase = getBrowserClient();
    await supabase.from('promos').update({ is_active: !p.is_active }).eq('id', p.id);
    void refresh();
  };

  const remove = async (p: Promo) => {
    if (!confirm(`Delete promo ${p.code}?`)) return;
    const supabase = getBrowserClient();
    await supabase.from('promos').delete().eq('id', p.id);
    void refresh();
  };

  const formatKind = (p: Promo) => {
    if (p.kind === 'percent_off') return `${p.value}% off`;
    if (p.kind === 'fixed_off') return `$${p.value} off`;
    return 'Free delivery';
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">Promo codes</h1>
          <p className="mt-1 text-muted-foreground">Discount codes customers can enter at checkout.</p>
        </div>
        <Button onClick={() => setComposing((c) => !c)} variant={composing ? 'ghost' : 'gradient'} leftIcon={<Plus className="h-4 w-4" />}>
          {composing ? 'Cancel' : 'New promo'}
        </Button>
      </header>

      {composing && (
        <Card className="mb-6 space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Code">
              <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} className="input" placeholder="WELCOME10" />
            </Field>
            <Field label="Type">
              <select value={kind} onChange={(e) => setKind(e.target.value as Promo['kind'])} className="input">
                <option value="percent_off">% off</option>
                <option value="fixed_off">Fixed USD off</option>
                <option value="free_delivery">Free delivery</option>
              </select>
            </Field>
            {kind !== 'free_delivery' && (
              <Field label={kind === 'percent_off' ? 'Percent (1–100)' : 'USD amount'}>
                <input value={value} onChange={(e) => setValue(e.target.value)} className="input" inputMode="decimal" />
              </Field>
            )}
            <Field label="Minimum subtotal (USD)">
              <input value={minSubtotal} onChange={(e) => setMinSubtotal(e.target.value.replace(/[^0-9.]/g, ''))} className="input" inputMode="decimal" />
            </Field>
            <Field label="Max redemptions (optional)">
              <input value={maxRedemptions} onChange={(e) => setMaxRedemptions(e.target.value.replace(/\D/g, ''))} className="input" inputMode="numeric" placeholder="unlimited" />
            </Field>
            <Field label="Ends at (optional)">
              <input value={endsAt} onChange={(e) => setEndsAt(e.target.value)} type="datetime-local" className="input" />
            </Field>
          </div>
          {error && <p className="rounded-xl bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
          <Button variant="gradient" onClick={create} disabled={!code} loading={busy}>Create promo</Button>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState icon={<Tag className="h-7 w-7" />} title="No promos yet" description="Create a promo code to start running campaigns." />
      ) : (
        <Card className="divide-y divide-border/40">
          {list.map((p) => (
            <div key={p.id} className="flex items-center justify-between p-4">
              <div>
                <p className="font-mono text-lg font-bold">{p.code}</p>
                <p className="text-xs text-muted-foreground">
                  {formatKind(p)} · min ${p.min_subtotal} · used {p.redemption_count}{p.max_redemptions ? `/${p.max_redemptions}` : ''}
                  {p.ends_at && ` · ends ${new Date(p.ends_at).toLocaleDateString()}`}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={p.is_active ? 'success' : 'muted'}>{p.is_active ? 'Active' : 'Paused'}</Badge>
                <button onClick={() => toggleActive(p)} className="text-xs text-muted-foreground underline">
                  {p.is_active ? 'Pause' : 'Activate'}
                </button>
                <IconButton label="Delete" size="sm" className="text-danger" onClick={() => remove(p)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          ))}
        </Card>
      )}

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block"><span className="mb-1.5 block text-sm font-medium">{label}</span>{children}</label>;
}
