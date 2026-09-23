'use client';

// Catalog manager over billing_products.
//
// Two things this fixes versus the plans editor it replaces:
//   • stripe_price_id is editable. It was not editable anywhere before, which
//     made switching Stripe on impossible without hand-writing SQL.
//   • Partial saves no longer clobber the features jsonb. upsert_billing_product
//     treats null as "leave alone", and the feature grid always sends the full
//     map, so a price edit cannot silently drop a feature key.
//
// Since 2026-09-23 a product carries TWO prices (docs/PACKAGING-2026-09-23.md):
// one_time_price is paid once ever, monthly_price every month. They are edited
// side by side and never added together — the base is $228 once AND $29 a month,
// and a single figure would be a lie whichever way it was computed.
//
// A withdrawn product (is_active = false) is kept, never deleted:
// subscription_items.product_code has an FK to it and the history must still
// resolve. It has to READ as withdrawn, though, or the AI Suite goes on looking
// like something a merchant can still buy.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { upsertBillingProduct } from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  FEATURE_KEYS,
  featureLabel,
  isUiLocale,
  type BillingProduct,
} from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

/** Catalog prices are whole dollars; the cents would be noise on every row. */
const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

const EMPTY: BillingProduct = {
  code: '',
  name: '',
  kind: 'addon',
  monthly_price: 0,
  one_time_price: 0,
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

/** billing_products.kind values. The value is stored; only the label is translated. */
const KINDS = ['plan', 'addon', 'seat'] as const;
const isKnownKind = (kind: string): kind is (typeof KINDS)[number] =>
  (KINDS as readonly string[]).includes(kind);

/** Raw PostgREST text is for the logs, never the screen. */
function saveErrorKey(raw: string | undefined): string {
  if (!raw) return 'errors.saveFailed';
  console.error('[platform/plans] upsert_billing_product failed:', raw);
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.saveFailed';
}

export function PlansManager({ products }: { products: BillingProduct[] }) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  const missingPrices = products.filter(
    (p) => p.is_active && p.code !== 'trial' && !p.stripe_price_id,
  );

  // What is on sale comes first: a withdrawn product is history, and reading the
  // catalog top-down should read the price list a merchant is actually offered.
  const ordered = [...products].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active) || a.sort_order - b.sort_order,
  );

  // A feature key nothing ACTIVE grants is not for sale any more, whatever the
  // withdrawn rows still carry. Derived from the catalog rather than naming
  // ai_suite here, so the next product the owner retires needs no code change.
  const soldFeatures = new Set(
    products.filter((p) => p.is_active).flatMap((p) => Object.keys(p.features ?? {})),
  );

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('plans.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('plans.subtitle')}</p>
        </div>
        {!creating && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t('plans.newProduct')}
          </Button>
        )}
      </header>
      <PlatformNav />

      {missingPrices.length > 0 && (
        <p className="mb-4 rounded-xl bg-warning/15 px-4 py-3 text-sm">
          {t.rich('plans.stripeDormant', {
            count: missingPrices.length,
            codes: missingPrices.map((p) => p.code).join(', '),
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
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
            soldFeatures={soldFeatures}
            onCancel={() => setCreating(false)}
            onError={setError}
            onSaved={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        )}
        {ordered.map((p) => (
          <ProductEditor
            key={p.code}
            initial={p}
            soldFeatures={soldFeatures}
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
  soldFeatures,
  onSaved,
  onError,
  onCancel,
}: {
  initial: BillingProduct;
  isNew?: boolean;
  /** Feature keys at least one active product still grants. Anything else is withdrawn. */
  soldFeatures: Set<string>;
  onSaved: () => void;
  onError: (msg: string | null) => void;
  onCancel?: () => void;
}) {
  const t = useTranslations('platformBilling');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
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
      onError(t('plans.codeRequired'));
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
      onError(t(saveErrorKey(res.error)));
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
          <span className="font-mono text-sm font-semibold">
            {isNew ? t('plans.newProductCode') : d.code}
          </span>
          <Badge variant="muted">{isKnownKind(d.kind) ? t(`plans.kinds.${d.kind}`) : d.kind}</Badge>
          {!d.is_active && <Badge variant="danger">{t('plans.withdrawn')}</Badge>}
          {d.is_active && d.code !== 'trial' && !d.stripe_price_id && (
            <Badge variant="warning">{t('plans.noStripePrice')}</Badge>
          )}
        </div>
        <button
          type="button"
          onClick={() => set({ is_active: !d.is_active })}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {d.is_active ? t('plans.markInactive') : t('plans.markActive')}
        </button>
      </div>

      {/* The two prices side by side and never summed: the base is $228 once AND
          $29 a month, and one blended number would be wrong whichever way it was
          computed. */}
      <p className="mb-3 text-sm">
        {t.rich('plans.priceSummary', {
          once: money(d.one_time_price),
          monthly: money(d.monthly_price),
          b: (chunks) => <span className="font-semibold">{chunks}</span>,
        })}
      </p>

      {/* A dimmed card is not a sentence. Say what withdrawn means for the people
          already on it, so nobody reactivates a product to "fix" a merchant. */}
      {!d.is_active && (
        <p className="mb-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
          {t('plans.withdrawnHint')}
        </p>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isNew && text(t('plans.fields.code'), 'code')}
        {text(t('plans.fields.name'), 'name')}
        {num(t('plans.fields.oneTimePrice'), 'one_time_price', t('plans.fields.oneTimePriceHint'))}
        {num(t('plans.fields.monthlyPrice'), 'monthly_price', t('plans.fields.monthlyPriceHint'))}
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('plans.fields.kind')}
          </span>
          <select
            value={d.kind}
            onChange={(e) => set({ kind: e.target.value })}
            className={INPUT_CLS}
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {t(`plans.kinds.${kind}`)}
              </option>
            ))}
          </select>
        </label>
        {num(t('plans.fields.includedSeats'), 'included_seats', t('plans.fields.includedSeatsHint'))}
        {num(t('plans.fields.seatsPerUnit'), 'seats_per_unit', t('plans.fields.seatsPerUnitHint'))}
        {num(t('plans.fields.trialDays'), 'trial_days')}
        {num(t('plans.fields.sortOrder'), 'sort_order')}
        {text(t('plans.fields.stripePriceId'), 'stripe_price_id', t('plans.fields.stripePriceIdHint'))}
      </div>

      <label className="mt-3 block">
        <span className="mb-1 block text-xs font-medium text-muted-foreground">
          {t('plans.fields.description')}
        </span>
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
        {t('plans.fields.isQuantity')}
      </label>

      <fieldset className="mt-4">
        <legend className="mb-2 text-xs font-medium text-muted-foreground">
          {t('plans.fields.features')}
        </legend>
        <div className="flex flex-wrap gap-2">
          {FEATURE_KEYS.map((k) => {
            const on = d.features[k] === true;
            // A key no active product grants any more is withdrawn: the dashed
            // outline and the suffix stop it reading like something on sale,
            // while leaving it switchable for the day the owner relaunches it.
            const withdrawn = !soldFeatures.has(k) && !on;
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleFeature(k)}
                aria-pressed={on}
                className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : withdrawn
                      ? 'border-dashed border-border text-muted-foreground/70 hover:bg-muted'
                      : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {withdrawn
                  ? t('plans.featureWithdrawn', { feature: featureLabel(k, locale) })
                  : featureLabel(k, locale)}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {isNew ? t('plans.createProduct') : t('plans.save')}
        </Button>
        {isNew && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {t('plans.cancel')}
          </button>
        )}
      </div>
    </Card>
  );
}
