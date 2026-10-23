'use client';

// Catalog manager over billing_products.
//
// Two things this fixes versus the plans editor it replaces:
//   • stripe_price_id is editable. Since 2026-09-26 nothing needs it: card billing
//     (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §4.1) finds or creates its Stripe
//     prices by lookup key from the amounts on this page, so the page no longer warns
//     about an empty one — that warning told the owner card billing could not start
//     until they typed ids the new code never reads.
//   • Partial saves no longer clobber the features jsonb. upsert_billing_product
//     treats null as "leave alone", and the feature grid always sends the full
//     map, so a price edit cannot silently drop a feature key.
//
// A product carries TWO prices (docs/PACKAGING-2026-10-24.md §4.1): one_time_price
// is paid once ever, monthly_price every month. They are edited side by side and
// never added together — the plan is $199 once AND $49 a month, and a single figure
// would be a lie whichever way it was computed.
//
// A withdrawn product (is_active = false) is kept, never deleted:
// subscription_items.product_code has an FK to it and the history must still
// resolve. It has to READ as withdrawn, though, or the AI Suite goes on looking
// like something a merchant can still buy.
//
// A withdrawn FEATURE (docs/PACKAGING-2026-10-24.md §2: AI Suite, AI Voice, Digital
// Signage, AI menu import) cannot be switched on for a product at all: a product grants
// its features to every restaurant on it, and nothing sells these any more. One left on
// from before can still be switched off. A deliberate exception for one restaurant is a
// platform feature switch on its Subscriptions card, not a catalog edit.

import * as React from 'react';
import Link from 'next/link';
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
import { isWithdrawnFeature } from '../../_components/platform-billing';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

// Whole dollars as "$89", cents kept when there are any: a discounted one-time fee can be
// $49.50, and a rounded figure here would disagree with the ledger it summarises.
const money = (n: number) => {
  const v = Number(n ?? 0);
  if (!Number.isFinite(v)) return '$0';
  return Number.isInteger(v) ? `$${v.toFixed(0)}` : `$${v.toFixed(2)}`;
};

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

  // What is on sale comes first: a withdrawn product is history, and reading the
  // catalog top-down should read the price list a merchant is actually offered.
  const ordered = [...products].sort(
    (a, b) => Number(b.is_active) - Number(a.is_active) || a.sort_order - b.sort_order,
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

      {/* What a price edit does to card billing: the amount is in the Stripe price's
          lookup key, so a new monthly price is a new Stripe price and nobody already
          paying by card is repriced by it. */}
      <p className="mb-4 rounded-xl bg-info/10 px-4 py-3 text-sm text-info">
        {t.rich('stripe.plans.note', {
          link: (chunks) => (
            <Link href="/platform/billing-setup" className="font-medium underline underline-offset-2">
              {chunks}
            </Link>
          ),
        })}
      </p>

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
        {ordered.map((p) => (
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
      // The button is disabled for these; refusing here as well keeps a keyboard or a
      // future caller from granting one anyway.
      else if (!isWithdrawnFeature(key)) next[key] = true;
      return { ...v, features: next };
    });

  // A withdrawn key still on from before: said in words under the grid, not only in red.
  const carriesWithdrawn = FEATURE_KEYS.some((k) => isWithdrawnFeature(k) && d.features[k] === true);

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
        </div>
        <button
          type="button"
          onClick={() => set({ is_active: !d.is_active })}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {d.is_active ? t('plans.markInactive') : t('plans.markActive')}
        </button>
      </div>

      {/* The two prices side by side and never summed: the plan is $199 once AND
          $49 a month, and one blended number would be wrong whichever way it was
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
        {text(t('plans.fields.stripePriceId'), 'stripe_price_id', t('stripe.plans.priceIdHint'))}
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
            // A withdrawn key reads as withdrawn and cannot be switched on: the dashed
            // outline and the suffix stop it reading like something on sale. One still
            // on from before is painted as a problem and can only be switched off.
            const withdrawn = isWithdrawnFeature(k);
            return (
              <button
                key={k}
                type="button"
                onClick={() => toggleFeature(k)}
                aria-pressed={on}
                disabled={withdrawn && !on}
                title={withdrawn ? t('plans.featureWithdrawnHint') : undefined}
                className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
                  withdrawn
                    ? on
                      ? 'border-danger bg-danger/10 text-danger'
                      : 'border-dashed border-border text-muted-foreground/70'
                    : on
                      ? 'border-primary bg-primary/10 text-primary'
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
        <p className={`mt-2 text-[11px] ${carriesWithdrawn ? 'text-danger' : 'text-muted-foreground'}`}>
          {carriesWithdrawn ? t('plans.withdrawnFeatureOn') : t('plans.featureWithdrawnHint')}
        </p>
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
