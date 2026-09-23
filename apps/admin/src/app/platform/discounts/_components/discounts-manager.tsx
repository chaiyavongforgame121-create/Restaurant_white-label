'use client';

// Discount codes, the platform's own.
//
// One thing about them decides the whole screen: a code comes off the ONE-TIME
// charges — the base, an extra branch, a branch's delivery unlock — and never off
// the monthly bill (docs/PACKAGING-2026-09-23.md §3.4). That keeps the recurring
// figure one number everyone can check, and it is said on the page rather than
// left for an operator to discover by watching a total not move.
//
// A code is never deleted. billing_discount_redemptions points at it, and a code
// that has been given away has to keep its history — so the only way to stop one
// is to deactivate it, and the list keeps showing it.
//
// Nothing here prices anything. The operator sets the rule; the server quotes it
// (private.billing_discount_quote) and reserves a use the moment a merchant sends a
// request with it, so the caps hold at submission and a code switched off afterwards
// never strands a request the merchant was already quoted. Approving keeps the use;
// rejecting or replacing the request gives it back. Until then the use is shown as
// reserved, not as money given away.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Plus, Save, Ticket } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  createDiscountCode,
  updateDiscountCode,
  type DiscountCode,
  type DiscountRedemption,
} from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  intlLocaleFor,
  isUiLocale,
  type BillingProduct,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, Card, EmptyState, useConfirm } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';
import { formatMoney } from '../../_components/platform-billing';
import {
  EMPTY_DRAFT,
  codeState,
  draftFrom,
  draftToInput,
  draftToPatch,
  normalizeCode,
  isReservedUse,
  remainingRedemptions,
  splitRedemptions,
  validateDraft,
  writeErrorKey,
  type CodeState,
  type DraftCode,
  type DraftError,
} from './discount-codes';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

const money = formatMoney;

const STATE_VARIANT: Record<CodeState, 'success' | 'warning' | 'muted'> = {
  live: 'success',
  scheduled: 'warning',
  expired: 'muted',
  exhausted: 'muted',
  inactive: 'muted',
};

// Same day on server and browser: Vercel runs in UTC and the operator's browser
// does not, and the date inputs on this screen are read as UTC too.
const fmtDate = (v: string | null | undefined, locale: UiLocale) =>
  v
    ? new Intl.DateTimeFormat(intlLocaleFor(locale), {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(v))
    : null;

function useUiLocale(): UiLocale {
  const rawLocale = useLocale();
  return isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
}

export function DiscountsManager({
  codes,
  redemptions,
  pendingRequestIds,
  catalog,
  nowMs,
}: {
  codes: DiscountCode[];
  /** Keyed by code id. A code with no uses is absent, not empty. */
  redemptions: Record<string, DiscountRedemption[]>;
  /** Requests still waiting for approval: a use tied to one is reserved, not yet given. */
  pendingRequestIds: string[];
  /** The whole catalog, withdrawn products included, so an old code's product
   *  list can still be named. Prices come from here and nowhere else. */
  catalog: BillingProduct[];
  /** The server clock, so "Scheduled" and "Expired" agree on both sides. */
  nowMs: number;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  // Only products with a one-time price can be discounted at all, and only the
  // active ones are worth offering on a new code.
  const oneTimeProducts = catalog.filter((p) => p.one_time_price > 0 && p.is_active);
  const taken = codes.map((c) => c.code);
  const pendingIds = React.useMemo(() => new Set(pendingRequestIds), [pendingRequestIds]);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('discounts.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('discounts.subtitle')}</p>
        </div>
        {!creating && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            {t('discounts.newCode')}
          </Button>
        )}
      </header>
      <PlatformNav />

      {/* The one sentence that stops a code being sold as "20% off your bill". */}
      <p className="mb-4 rounded-xl bg-primary/10 px-4 py-3 text-sm">
        {t.rich('discounts.oneTimeOnly', { strong: (chunks) => <strong>{chunks}</strong> })}
      </p>

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="space-y-4">
        {creating && (
          <Card className="p-5">
            <CodeEditor
              key="__new__"
              draft={EMPTY_DRAFT}
              isNew
              taken={taken}
              oneTimeProducts={oneTimeProducts}
              onCancel={() => setCreating(false)}
              onError={setError}
              onSaved={() => {
                setCreating(false);
                router.refresh();
              }}
            />
          </Card>
        )}

        {codes.length === 0 && !creating ? (
          <EmptyState
            icon={<Ticket className="h-7 w-7" aria-hidden />}
            title={t('discounts.emptyTitle')}
            description={t('discounts.emptyBody')}
            action={<Button onClick={() => setCreating(true)}>{t('discounts.newCode')}</Button>}
          />
        ) : (
          codes.map((code) => (
            <CodeCard
              key={code.id}
              code={code}
              redemptions={redemptions[code.id] ?? null}
              pendingIds={pendingIds}
              taken={taken}
              catalog={catalog}
              oneTimeProducts={oneTimeProducts}
              nowMs={nowMs}
              onError={setError}
            />
          ))
        )}
      </div>
    </div>
  );
}

function CodeCard({
  code,
  redemptions,
  pendingIds,
  taken,
  catalog,
  oneTimeProducts,
  nowMs,
  onError,
}: {
  code: DiscountCode;
  /** null means this code has never been used, so nothing was read for it. */
  redemptions: DiscountRedemption[] | null;
  pendingIds: ReadonlySet<string>;
  taken: string[];
  catalog: BillingProduct[];
  oneTimeProducts: BillingProduct[];
  nowMs: number;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  const confirm = useConfirm();
  const [editing, setEditing] = React.useState(false);
  const [showUses, setShowUses] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const state = codeState(code, nowMs);
  const left = remainingRedemptions(code);

  // What has actually been given away, and what is only held for requests still waiting —
  // see splitRedemptions(). A code with uses but no rows on hand means the redemption read
  // failed — saying "$0" there would be a lie about money.
  const split = redemptions === null ? null : splitRedemptions(redemptions, pendingIds);
  const givenAway = split
    ? split.given
    : code.redemption_count > 0
      ? null
      : 0;
  const reservedAmount = split?.reserved ?? 0;

  const gives =
    code.kind === 'percent'
      ? t('discounts.givesPercent', { value: code.value })
      : t('discounts.givesFixed', { amount: money(code.value) });

  const appliesTo =
    code.product_codes.length === 0
      ? t('discounts.appliesAll')
      : code.product_codes
          .map((c) => catalog.find((p) => p.code === c)?.name ?? c)
          .join(', ');

  const starts = fmtDate(code.starts_at, locale);
  const ends = fmtDate(code.ends_at, locale);
  const windowText = ends
    ? t('discounts.windowBetween', { from: starts ?? '—', to: ends })
    : t('discounts.windowFrom', { from: starts ?? '—' });

  const setActive = async (isActive: boolean) => {
    if (!isActive) {
      const ok = await confirm({
        title: t('discounts.confirmDeactivate.title', { code: code.code }),
        body: t('discounts.confirmDeactivate.body'),
        confirmLabel: t('discounts.confirmDeactivate.confirm'),
        destructive: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    onError(null);
    try {
      await updateDiscountCode(getBrowserClient(), code.id, { is_active: isActive });
      router.refresh();
    } catch (e) {
      onError(t(writeErrorKey(e instanceof Error ? e.message : String(e))));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className={`p-5 ${state === 'live' ? '' : 'opacity-80'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-base font-bold tracking-wide">{code.code}</span>
            <Badge variant={STATE_VARIANT[state]}>{t(`discounts.state.${state}`)}</Badge>
          </div>
          {code.description && (
            <p className="mt-1 text-sm text-muted-foreground">{code.description}</p>
          )}
        </div>
        <p className="font-display text-xl font-bold">{gives}</p>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label={t('discounts.stats.appliesTo')} value={appliesTo} />
        <Stat
          label={t('discounts.stats.used')}
          value={
            left === null
              ? t('discounts.usedUnlimited', { count: code.redemption_count })
              : t('discounts.usedOfMax', { count: code.redemption_count, max: code.max_redemptions ?? 0 })
          }
        />
        <Stat
          label={t('discounts.stats.perRestaurant')}
          value={t('discounts.perRestaurantValue', { count: code.per_restaurant_limit })}
        />
        {/* Money given away, never mixed with anything monthly: these codes only
            ever come off a one-time charge. */}
        <Stat
          label={t('discounts.stats.givenAway')}
          value={givenAway === null ? '—' : money(givenAway)}
        />
      </dl>

      {reservedAmount > 0 && (
        <p className="mt-2 text-xs text-warning">
          {t('discounts.reservedNote', { amount: money(reservedAmount) })}
        </p>
      )}
      <p className="mt-2 text-xs text-muted-foreground">{windowText}</p>

      <div className="mt-3 flex flex-wrap gap-4">
        <button
          type="button"
          onClick={() => setEditing((v) => !v)}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {editing ? t('discounts.close') : t('discounts.edit')}
        </button>
        {code.redemption_count > 0 && (
          <button
            type="button"
            onClick={() => setShowUses((v) => !v)}
            className="text-sm text-primary underline-offset-2 hover:underline"
          >
            {showUses
              ? t('discounts.close')
              : t('discounts.showUses', { count: code.redemption_count })}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => setActive(!code.is_active)}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline disabled:opacity-50"
        >
          {code.is_active ? t('discounts.deactivate') : t('discounts.reactivate')}
        </button>
      </div>

      {showUses && <Redemptions rows={redemptions} pendingIds={pendingIds} locale={locale} />}

      {editing && (
        <div className="mt-4 border-t border-border pt-4">
          <CodeEditor
            draft={draftFrom(code)}
            codeId={code.id}
            taken={taken}
            oneTimeProducts={oneTimeProducts}
            onCancel={() => setEditing(false)}
            onError={onError}
            onSaved={() => {
              setEditing(false);
              router.refresh();
            }}
          />
        </div>
      )}
    </Card>
  );
}

/** Who used the code, on which request, and for how much. */
function Redemptions({
  rows,
  pendingIds,
  locale,
}: {
  rows: DiscountRedemption[] | null;
  pendingIds: ReadonlySet<string>;
  locale: UiLocale;
}) {
  const t = useTranslations('platformBilling');
  if (rows === null || rows.length === 0) {
    return (
      <p className="mt-4 border-t border-border pt-4 text-sm text-warning">
        {t('discounts.usesUnavailable')}
      </p>
    );
  }
  return (
    <div className="mt-4 border-t border-border pt-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {t('discounts.usesTitle')}
      </p>
      <ul className="mt-2 divide-y divide-border text-sm">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0">
              <p className="truncate font-medium">
                {r.restaurant_name ?? t('discounts.unknownRestaurant')}
              </p>
              <p className="text-[11px] text-muted-foreground">
                {fmtDate(r.redeemed_at, locale) ?? '—'}
                {r.request_id
                  ? ` · ${t('discounts.onRequest', { id: r.request_id.slice(0, 8) })}`
                  : ''}
              </p>
            </div>
            {isReservedUse(r, pendingIds) ? (
              // Held for a request that is still waiting: given back if it is rejected.
              <span className="flex items-center gap-2">
                <Badge variant="warning">{t('discounts.reserved')}</Badge>
                <span className="tabular-nums text-muted-foreground">
                  −{formatMoney(r.amount_off)}
                </span>
              </span>
            ) : (
              <span className="tabular-nums text-success">−{formatMoney(r.amount_off)}</span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CodeEditor({
  draft: initial,
  codeId,
  isNew,
  taken,
  oneTimeProducts,
  onSaved,
  onError,
  onCancel,
}: {
  draft: DraftCode;
  /** Set when editing: the row to patch. */
  codeId?: string;
  isNew?: boolean;
  taken: string[];
  oneTimeProducts: BillingProduct[];
  onSaved: () => void;
  onError: (m: string | null) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('platformBilling');
  const [d, setD] = React.useState<DraftCode>(initial);
  const [problems, setProblems] = React.useState<DraftError[]>([]);
  const [saving, setSaving] = React.useState(false);
  const set = (patch: Partial<DraftCode>) => setD((v) => ({ ...v, ...patch }));

  const toggleProduct = (code: string) =>
    setD((v) => ({
      ...v,
      productCodes: v.productCodes.includes(code)
        ? v.productCodes.filter((c) => c !== code)
        : [...v.productCodes, code],
    }));

  const save = async () => {
    onError(null);
    const found = validateDraft(d, taken, isNew ? undefined : initial.code);
    setProblems(found);
    if (found.length > 0) return;

    setSaving(true);
    try {
      if (isNew) {
        await createDiscountCode(getBrowserClient(), draftToInput(d));
      } else if (codeId) {
        await updateDiscountCode(getBrowserClient(), codeId, draftToPatch(d));
      }
      onSaved();
    } catch (e) {
      onError(t(writeErrorKey(e instanceof Error ? e.message : String(e))));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-xs uppercase tracking-wider text-muted-foreground">
        {isNew ? t('discounts.form.newTitle') : t('discounts.form.editTitle')}
      </p>

      {problems.length > 0 && (
        <ul className="space-y-1 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {problems.map((p) => (
            <li key={p}>{t(`discounts.errors.${p}`)}</li>
          ))}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.code')}
          </span>
          <input
            type="text"
            value={d.code}
            disabled={!isNew}
            // Upper-cased as it is typed, because that is what is stored and
            // compared — seeing it change later reads as the form editing itself.
            onChange={(e) => set({ code: normalizeCode(e.target.value) })}
            className={`${INPUT_CLS} font-mono uppercase disabled:opacity-60`}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {isNew ? t('discounts.form.codeHint') : t('discounts.form.codeLocked')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.description')}
          </span>
          <input
            type="text"
            value={d.description}
            onChange={(e) => set({ description: e.target.value })}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('discounts.form.descriptionHint')}
          </span>
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              {t('discounts.form.kind')}
            </span>
            <select
              value={d.kind}
              onChange={(e) => set({ kind: e.target.value === 'fixed' ? 'fixed' : 'percent' })}
              className={INPUT_CLS}
            >
              <option value="percent">{t('discounts.form.kindPercent')}</option>
              <option value="fixed">{t('discounts.form.kindFixed')}</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-muted-foreground">
              {d.kind === 'percent' ? t('discounts.form.valuePercent') : t('discounts.form.valueFixed')}
            </span>
            <input
              type="number"
              min="1"
              step="1"
              value={d.value}
              onChange={(e) => set({ value: e.target.value })}
              className={INPUT_CLS}
            />
          </label>
        </div>
      </div>

      <fieldset>
        <legend className="mb-1 text-xs font-medium text-muted-foreground">
          {t('discounts.form.appliesTo')}
        </legend>
        <p className="mb-2 text-[11px] text-muted-foreground">{t('discounts.form.appliesToHint')}</p>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            aria-pressed={d.productCodes.length === 0}
            onClick={() => set({ productCodes: [] })}
            className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
              d.productCodes.length === 0
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border text-muted-foreground hover:bg-muted'
            }`}
          >
            {t('discounts.appliesAll')}
          </button>
          {oneTimeProducts.map((p) => {
            const on = d.productCodes.includes(p.code);
            return (
              <button
                key={p.code}
                type="button"
                aria-pressed={on}
                onClick={() => toggleProduct(p.code)}
                className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                  on
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:bg-muted'
                }`}
              >
                {t('discounts.form.productChip', {
                  name: p.name,
                  amount: money(p.one_time_price),
                })}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.maxRedemptions')}
          </span>
          <input
            type="number"
            min="1"
            step="1"
            value={d.maxRedemptions}
            onChange={(e) => set({ maxRedemptions: e.target.value })}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('discounts.form.maxRedemptionsHint')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.perRestaurant')}
          </span>
          <input
            type="number"
            min="1"
            step="1"
            value={d.perRestaurantLimit}
            onChange={(e) => set({ perRestaurantLimit: e.target.value })}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('discounts.form.perRestaurantHint')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.startsAt')}
          </span>
          <input
            type="date"
            value={d.startsAt}
            onChange={(e) => set({ startsAt: e.target.value })}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('discounts.form.startsAtHint')}
          </span>
        </label>

        <label className="block">
          <span className="mb-1 block text-xs font-medium text-muted-foreground">
            {t('discounts.form.endsAt')}
          </span>
          <input
            type="date"
            value={d.endsAt}
            onChange={(e) => set({ endsAt: e.target.value })}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-[11px] text-muted-foreground">
            {t('discounts.form.endsAtHint')}
          </span>
        </label>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={d.isActive}
          onChange={(e) => set({ isActive: e.target.checked })}
          className="h-4 w-4 rounded border-border"
        />
        {t('discounts.form.isActive')}
      </label>

      <div className="flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {isNew ? t('discounts.form.create') : t('discounts.form.save')}
        </Button>
        <button
          type="button"
          onClick={onCancel}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('discounts.form.cancel')}
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold">{value}</dd>
    </div>
  );
}
