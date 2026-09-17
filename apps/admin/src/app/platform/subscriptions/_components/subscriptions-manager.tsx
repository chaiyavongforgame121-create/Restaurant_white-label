'use client';

// The manual activation rail.
//
// While Stripe is dormant this page is the ONLY thing that turns a paying
// customer on. billing_set_package writes the subscription + its line items and
// recomputes entitlements synchronously, so a save here is live for the merchant
// on their next request — no cron, no cache purge.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Check, Minus, Plus, Search } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  setFeatureOverride,
  setRestaurantPackage,
  type RestaurantSubscriptionRow,
} from '@favornoms/database/queries';
import {
  DEFAULT_UI_LOCALE,
  FEATURE_KEYS,
  PLAN_BASE,
  currentSelection,
  featureLabel,
  featureOverrideState,
  intlLocaleFor,
  isUiLocale,
  packageMonthlyTotal,
  type BillingProduct,
  type FeatureKey,
  type FeatureOverrideState,
  type PackageSelection,
  type UiLocale,
} from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';
import { addOneMonthUtc } from '../../_components/tenant-health';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

const STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];
const isStatus = (value: string): value is Status => (STATUSES as readonly string[]).includes(value);

// billing_compute grants entitled_through = greatest(period_end, trial_end) to
// past_due and cancelled exactly as it does to active, so picking either one to
// close a store switched nothing off. The option text (subscriptions.statusOption)
// says so before it is chosen, and subscriptions.statusHint repeats it after.
const HINTED_STATUSES: readonly Status[] = ['past_due', 'cancelled', 'expired'];

const money = (n: number) => `$${Number(n).toFixed(0)}`;

// Pin the locale: an unpinned toLocaleDateString() renders in whatever locale the
// *server* runs under (a Thai dev box turned "8/8/2026" into the Buddhist-calendar
// "8/8/2569"). Pinning to the reader's interface language (Gregorian in Thai, via
// intlLocaleFor) also keeps SSR and the client agreeing, so there's no hydration mismatch.
const date = (v: string, locale: UiLocale) => new Date(v).toLocaleDateString(intlLocaleFor(locale));

// Same day on server and browser: Vercel runs in UTC and the operator's browser does not.
const fmtDate = (v: string | null | undefined, locale: UiLocale) =>
  v
    ? new Intl.DateTimeFormat(intlLocaleFor(locale), {
        timeZone: 'UTC',
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }).format(new Date(v))
    : '—';

/** Raw PostgREST text is for the logs, never the screen. */
function saveErrorKey(raw: string | undefined): string {
  if (!raw) return 'errors.saveFailed';
  console.error('[platform/subscriptions] save failed:', raw);
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.saveFailed';
}

function useUiLocale(): UiLocale {
  const rawLocale = useLocale();
  return isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
}

export function SubscriptionsManager({
  rows,
  catalog,
  initialQuery = '',
  nowMs,
}: {
  rows: RestaurantSubscriptionRow[];
  catalog: BillingProduct[];
  /** A slug arriving from /platform's "Fix billing" — prefills the search and
   *  opens that restaurant's editor, so the deep link lands on the control. */
  initialQuery?: string;
  /** The server clock, so the "blank = …" date renders identically on both sides. */
  nowMs: number;
}) {
  const t = useTranslations('platformBilling');
  const [q, setQ] = React.useState(initialQuery);
  const focusSlug = initialQuery.trim().toLowerCase();
  const filtered = rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    if (!needle) return true;
    return (
      r.restaurant_name.toLowerCase().includes(needle) ||
      r.restaurant_slug.toLowerCase().includes(needle)
    );
  });

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">{t('subscriptions.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('subscriptions.subtitle')}</p>
      </header>
      <PlatformNav />

      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('subscriptions.searchPlaceholder')}
          className={`${INPUT_CLS} pl-9`}
        />
      </label>

      <div className="space-y-4">
        {filtered.map((row) => (
          <SubscriptionCard
            key={row.restaurant_id}
            row={row}
            catalog={catalog}
            nowMs={nowMs}
            defaultOpen={focusSlug === row.restaurant_slug.toLowerCase()}
          />
        ))}
        {filtered.length === 0 && (
          <p className="py-12 text-center text-muted-foreground">{t('subscriptions.noMatches')}</p>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({
  row,
  catalog,
  nowMs,
  defaultOpen = false,
}: {
  row: RestaurantSubscriptionRow;
  catalog: BillingProduct[];
  nowMs: number;
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  const ent = row.entitlements;
  const [open, setOpen] = React.useState(defaultOpen);
  const [sel, setSel] = React.useState<PackageSelection>(() => currentSelection(ent));
  const [status, setStatus] = React.useState<Status>(
    (STATUSES as readonly string[]).includes(ent.status) ? (ent.status as Status) : 'active',
  );
  const [periodEnd, setPeriodEnd] = React.useState('');
  const [featuresOpen, setFeaturesOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const addons = catalog.filter((p) => p.kind === 'addon');
  const plans = catalog.filter((p) => p.kind === 'plan');
  const total = packageMonthlyTotal(sel, catalog);
  const minSeats = Math.max(1, ent.branchesUsed);

  // What a blank "Paid through" actually writes (billing_apply_selection): the
  // period restarts at now() and ends after the plan's trial days or one month.
  // "Blank = +1 month" read as "one more month on top", so adding an add-on to a
  // store paid well ahead quietly handed back less time than it already had.
  const trialDays = catalog.find((p) => p.code === sel.planCode)?.trial_days ?? 0;
  const blankEnd = trialDays > 0 ? new Date(nowMs + trialDays * 86_400_000) : addOneMonthUtc(nowMs);
  const currentEnd = ent.entitledThrough ? Date.parse(ent.entitledThrough) : NaN;
  const blankShortens = !periodEnd && Number.isFinite(currentEnd) && currentEnd > blankEnd.getTime();
  const statusHint = HINTED_STATUSES.includes(status) ? t(`subscriptions.statusHint.${status}`) : null;

  const perMonth = (amount: string) =>
    t.rich('perMonth', {
      amount,
      unit: (chunks) => <span className="ml-1 text-sm font-normal text-muted-foreground">{chunks}</span>,
    });

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    const res = await setRestaurantPackage(
      getBrowserClient(),
      row.restaurant_id,
      { ...sel, branchSeats: Math.max(minSeats, sel.branchSeats) },
      status,
      periodEnd ? new Date(periodEnd).toISOString() : null,
    );
    setSaving(false);
    if (res.ok !== true) {
      setError(t(saveErrorKey(res.error)));
      return;
    }
    setSaved(true);
    router.refresh();
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">{row.restaurant_name}</h2>
          <p className="font-mono text-xs text-muted-foreground">{row.restaurant_slug}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={ent.entitled ? 'success' : 'danger'}>
            {ent.entitled ? t('subscriptions.live') : t('subscriptions.suspended')}
          </Badge>
          <Badge variant="muted">{ent.planCode}</Badge>
          <Badge variant="outline">
            {isStatus(ent.status) ? t(`subscriptionStatus.${ent.status}`) : ent.status}
          </Badge>
          {ent.addons.map((a) => (
            <Badge key={a} variant="default">
              {a}
            </Badge>
          ))}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label={t('subscriptions.stats.monthly')} value={money(ent.monthlyTotal)} />
        <Stat label={t('subscriptions.stats.seats')} value={`${ent.branchesUsed} / ${ent.branchSeats}`} />
        <Stat
          label={t('subscriptions.stats.paidThrough')}
          value={ent.entitledThrough ? date(ent.entitledThrough, locale) : '—'}
        />
        <Stat
          label={t('subscriptions.stats.trialEnds')}
          value={ent.trialEndsAt ? date(ent.trialEndsAt, locale) : '—'}
        />
      </dl>

      <div className="mt-3 flex flex-wrap gap-4">
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {open ? t('subscriptions.close') : t('subscriptions.changePackage')}
        </button>
        <button
          type="button"
          onClick={() => setFeaturesOpen((o) => !o)}
          className="text-sm text-primary underline-offset-2 hover:underline"
        >
          {featuresOpen ? t('subscriptions.close') : t('subscriptions.featureSwitches')}
        </button>
      </div>

      {featuresOpen && <FeatureSwitches row={row} />}

      {open && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {error && (
            <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('subscriptions.plan')}
              </span>
              <select
                value={sel.planCode}
                onChange={(e) => setSel((s) => ({ ...s, planCode: e.target.value }))}
                className={INPUT_CLS}
              >
                {plans.length === 0 && <option value={PLAN_BASE}>{PLAN_BASE}</option>}
                {plans.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.name} — {money(p.monthly_price)}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('subscriptions.status')}
              </span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                className={INPUT_CLS}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`subscriptions.statusOption.${s}`)}
                  </option>
                ))}
              </select>
              {statusHint && (
                <span className="mt-1 block text-[11px] text-muted-foreground">{statusHint}</span>
              )}
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                {t('subscriptions.paidThrough')}
              </span>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className={INPUT_CLS}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {trialDays > 0
                  ? t('subscriptions.blankTrial', {
                      days: trialDays,
                      date: fmtDate(blankEnd.toISOString(), locale),
                    })
                  : t('subscriptions.blankMonth', { date: fmtDate(blankEnd.toISOString(), locale) })}
              </span>
              {blankShortens && (
                <span className="mt-1 block text-[11px] font-medium text-danger">
                  {t('subscriptions.blankShortens', { date: fmtDate(ent.entitledThrough, locale) })}
                </span>
              )}
            </label>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-muted-foreground">
              {t('subscriptions.addons')}
            </span>
            <div className="flex flex-wrap gap-2">
              {addons.map((a) => {
                const on = sel.addons.includes(a.code);
                return (
                  <button
                    key={a.code}
                    type="button"
                    aria-pressed={on}
                    onClick={() =>
                      setSel((s) => ({
                        ...s,
                        addons: on
                          ? s.addons.filter((x) => x !== a.code)
                          : [...s.addons, a.code],
                      }))
                    }
                    className={`focus-ring rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                      on
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border text-muted-foreground hover:bg-muted'
                    }`}
                  >
                    {a.name} +{money(a.monthly_price)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t('subscriptions.branchSeats')}
              </span>
              <button
                type="button"
                aria-label={t('subscriptions.removeSeat')}
                disabled={sel.branchSeats <= minSeats}
                onClick={() => setSel((s) => ({ ...s, branchSeats: s.branchSeats - 1 }))}
                className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-border disabled:opacity-40"
              >
                <Minus className="h-4 w-4" />
              </button>
              <span className="w-6 text-center font-display text-lg font-bold tabular-nums">
                {sel.branchSeats}
              </span>
              <button
                type="button"
                aria-label={t('subscriptions.addSeat')}
                onClick={() => setSel((s) => ({ ...s, branchSeats: Math.min(99, s.branchSeats + 1) }))}
                className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-border"
              >
                <Plus className="h-4 w-4" />
              </button>
              {minSeats > 1 && (
                <span className="text-[11px] text-muted-foreground">
                  {t('subscriptions.minSeats', { count: minSeats })}
                </span>
              )}
            </div>

            <p className="font-display text-xl font-bold">{perMonth(money(total))}</p>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} loading={saving}>
              {t('subscriptions.applyPackage')}
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check className="h-4 w-4" /> {t('subscriptions.saved')}
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}

// Per-restaurant feature switches.
//
// Separate from the package on purpose: the trial plan grants AI Voice and
// Digital Signage to every restaurant, and both pages are still placeholders, so
// the operator needs to hide them for one customer without repricing the plan
// everyone else is on. "Plan" is the default and means: follow the package.
// Labels are switches.states.<value>.
const STATES: FeatureOverrideState[] = ['plan', 'on', 'off'];

function FeatureSwitches({ row }: { row: RestaurantSubscriptionRow }) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
  const locale = useUiLocale();
  // Seeded from the server row, then advanced from each RPC reply — the reply
  // carries the recomputed entitlements, so the "Merchant sees" column stays
  // truthful without waiting for router.refresh() to land.
  const [overrides, setOverrides] = React.useState(row.feature_overrides);
  const [granted, setGranted] = React.useState(row.entitlements.features);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const apply = async (feature: FeatureKey, state: FeatureOverrideState) => {
    setBusy(feature);
    setError(null);
    const res = await setFeatureOverride(getBrowserClient(), row.restaurant_id, feature, state);
    setBusy(null);
    if (!res.ok) {
      setError(t(saveErrorKey(res.error)));
      return;
    }
    if (res.overrides) setOverrides(res.overrides);
    if (res.entitlements) setGranted(res.entitlements.features);
    router.refresh();
  };

  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4">
      <p className="text-xs text-muted-foreground">
        {t.rich('switches.intro', { strong: (chunks) => <strong>{chunks}</strong> })}
      </p>

      {error && (
        <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <ul className="divide-y divide-border">
        {FEATURE_KEYS.map((key) => {
          const state = featureOverrideState(overrides, key);
          // The package's own answer, i.e. what "Plan" would resolve to. Derived
          // by undoing the switch rather than re-querying the catalog.
          const effective = granted[key] === true;
          const fromPlan = state === 'plan' ? effective : null;
          const label = featureLabel(key, locale);
          const visibility =
            state !== 'plan'
              ? effective
                ? 'switches.visibleOverridden'
                : 'switches.hiddenOverridden'
              : fromPlan === false
                ? 'switches.hiddenNotInPackage'
                : 'switches.visible';
          return (
            <li key={key} className="flex flex-wrap items-center justify-between gap-3 py-2.5">
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{t(visibility)}</p>
              </div>
              <div
                role="group"
                aria-label={t('switches.groupLabel', { feature: label })}
                className="inline-flex rounded-full border border-border bg-muted/50 p-0.5"
              >
                {STATES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={state === value}
                    disabled={busy === key}
                    onClick={() => apply(key, value)}
                    className={`focus-ring rounded-full px-3 py-1 text-xs font-semibold transition-colors disabled:opacity-50 ${
                      state === value
                        ? value === 'off'
                          ? 'bg-destructive text-destructive-foreground'
                          : 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:text-foreground'
                    }`}
                  >
                    {t(`switches.states.${value}`)}
                  </button>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
