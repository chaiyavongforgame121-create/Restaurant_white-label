'use client';

// Catalog manager over billing_products.
//
// Two things this fixes versus the plans editor it replaces:
//   • stripe_price_id is editable. It was not editable anywhere before, which
//     made switching Stripe on impossible without hand-writing SQL.
//   • Partial saves no longer clobber the features jsonb. upsert_billing_product
//     treats null as "leave alone", and the feature grid always sends the full
//     map, so a price edit cannot silently drop a feature key.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { upsertBillingProduct } from '@favornoms/database/queries';
import { FEATURE_KEYS, featureLabel, type BillingProduct } from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

const EMPTY: BillingProduct = {
  code: '',
  name: '',
  kind: 'addon',
  monthly_price: 0,
  included_seats: 0,
  seats_per_unit: 0,
  trial_days: 0,
  is_quantity: false,
  features: {},
  stripe_price_id: null,
  is_active: true,
  sort_order: 100,
  description: null,
};

export function PlansManager({ products }: { products: BillingProduct[] }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const missingPrices = products.filter(
    (p) => p.is_active && p.code !== 'trial' && !p.stripe_price_id,
  );

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Product catalog</h1>
          <p className="mt-1 text-muted-foreground">
            What restaurants can buy. Prices are monthly USD.
          </p>
        </div>
        {!creating && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New product
          </Button>
        )}
      </header>
      <PlatformNav />

      {missingPrices.length > 0 && (
        <p className="mb-4 rounded-xl bg-warning/15 px-4 py-3 text-sm">
          <strong>Stripe is dormant.</strong> {missingPrices.length} active product
          {missingPrices.length === 1 ? ' has' : 's have'} no Stripe price ID (
          {missingPrices.map((p) => p.code).join(', ')}). Until every one is filled in, merchants
          are activated manually from Subscriptions instead of paying by card.
        </p>
      )}

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="space-y-4">
        {creating && (
          <ProductEditor
            key="__new__"
            initial={EMPTY}
            isNew
            onCancel={() => setCreating(false)}
            onError={setError}
            onSaved={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        )}
        {products.map((p) => (
          <ProductEditor
            key={p.code}
            initial={p}
            onError={setError}
            onSaved={() => router.refresh()}
          />
        ))}
      </div>
    </div>
  );
}

function ProductEditor({
  initial,
  isNew,
  onSaved,
  onError,
  onCancel,
}: {
  initial: BillingProduct;
  isNew?: boolean;
  onSaved: () => void;
  onError: (msg: string | null) => void;
  onCancel?: () => void;
}) {
  const [d, setD] = React.useState<BillingProduct>(initial);
  const [saving, setSaving] = React.useState(false);
  const set = (patch: Partial<BillingProduct>) => setD((v) => ({ ...v, ...patch }));

  const toggleFeature = (key: string) =>
    setD((v) => {
      const next = { ...v.features };
      if (next[key]) delete next[key];
      else next[key] = true;
      return { ...v, features: next };
    });

  const save = async () => {
    onError(null);
    const code = d.code.trim().toLowerCase();
    if (!code) {
      onError('Product code is required.');
      return;
    }
    setSaving(true);
    const res = await upsertBillingProduct(getBrowserClient(), {
      ...d,
      code,
      name: d.name.trim() || code,
      // Always send the full map so a partial edit cannot drop a key.
      features: d.features,
      stripe_price_id: d.stripe_price_id?.trim() || null,
      description: d.description?.trim() || null,
    });
    setSaving(false);
    if (res.ok !== true) {
      onError(res.error ?? 'Could not save.');
      return;
    }
    onSaved();
  };

  const num = (label: string, key: keyof BillingProduct, hint?: string) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="number"
        step="1"
        value={String(d[key] ?? 0)}
        onChange={(e) => set({ [key]: Number(e.target.value) } as Partial<BillingProduct>)}
        className={INPUT_CLS}
      />
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );

  const text = (label: string, key: 'name' | 'code' | 'stripe_price_id' | 'description', hint?: string) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type="text"
        value={String(d[key] ?? '')}
        disabled={key === 'code' && !isNew}
        onChange={(e) => set({ [key]: e.target.value } as Partial<BillingProduct>)}
        className={`${INPUT_CLS} disabled:opacity-60`}
      />
      {hint && <span className="mt-1 block text-[11px] text-muted-foreground">{hint}</span>}
    </label>
  );

  return (
    <Card className={`p-5 ${!d.is_active ? 'opacity-70' : ''}`}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">{isNew ? 'new product' : d.code}</span>
          <Badge variant="muted">{d.kind}</Badge>
          {!d.is_active && <Badge variant="muted">Inactive</Badge>}
          {d.is_active && d.code !== 'trial' && !d.stripe_price_id && (
            <Badge variant="warning">No Stripe price</Badge>
          )}
        </div>
        <button
          type="button"
          onClick={() => set({ is_active: !d.is_active })}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {d.is_active ? 'Mark inactive' : 'Mark active'}
        </button>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isNew && text('Code (slug)', 'code')}
        {text('Name', 'name')}
        {num('Monthly price ($)', 'monthly_price')}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">Kind</span>
          <select
            value={d.kind}
            onChange={(e) => set({ kind: e.target.value })}
            className={INPUT_CLS}
          >
            <option value="plan">plan</option>
            <option value="addon">addon</option>
            <option value="seat">seat</option>
          </select>
        </label>
        {num('Seats included', 'included_seats', 'Seats the plan grants on its own.')}
        {num('Seats per unit', 'seats_per_unit', 'For quantity products (extra_branch = 1).')}
        {num('Trial days', 'trial_days')}
        {num('Sort order', 'sort_order')}
        {text('Stripe price ID', 'stripe_price_id', 'price_… — required before Stripe can go live.')}
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">Description</span>
        <input
          type="text"
          value={d.description ?? ''}
          onChange={(e) => set({ description: e.target.value })}
          className={INPUT_CLS}
        />
      </label>

      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={d.is_quantity}
          onChange={(e) => set({ is_quantity: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        Quantity product (billed per unit — needs quantity pricing on the Stripe price)
      </label>

      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          Features granted
        </legend>
        <div className="flex flex-wrap gap-2">
          {FEATURE_KEYS.map((k) => {
            const on = d.features[k] === true;
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleFeature(k)}
                aria-pressed={on}
                className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {featureLabel(k)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {isNew ? 'Create product' : 'Save'}
        </Button>
        {isNew && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
    </Card>
  );
}
