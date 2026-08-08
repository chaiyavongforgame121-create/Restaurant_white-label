'use client';

// The manual activation rail.
//
// While Stripe is dormant this page is the ONLY thing that turns a paying
// customer on. billing_set_package writes the subscription + its line items and
// recomputes entitlements synchronously, so a save here is live for the merchant
// on their next request — no cron, no cache purge.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, Minus, Plus, Search } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { setRestaurantPackage, type RestaurantSubscriptionRow } from '@favornoms/database/queries';
import {
  PLAN_BASE,
  PLAN_TRIAL,
  currentSelection,
  packageMonthlyTotal,
  type BillingProduct,
  type PackageSelection,
} from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

const STATUSES = ['active', 'trialing', 'past_due', 'cancelled', 'expired'] as const;
type Status = (typeof STATUSES)[number];

const money = (n: number) => `$${Number(n).toFixed(0)}`;

// Pin the locale: the market is US-only, and an unpinned toLocaleDateString()
// renders in whatever locale the *server* runs under (a Thai dev box turned
// "8/8/2026" into the Buddhist-calendar "8/8/2569"). Pinning also keeps SSR and
// the client agreeing, so there's no hydration mismatch.
const date = (v: string) => new Date(v).toLocaleDateString('en-US');

export function SubscriptionsManager({
  rows,
  catalog,
  initialQuery = '',
}: {
  rows: RestaurantSubscriptionRow[];
  catalog: BillingProduct[];
  /** A slug arriving from /platform's "Fix billing" — prefills the search and
   *  opens that restaurant's editor, so the deep link lands on the control. */
  initialQuery?: string;
}) {
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
        <h1 className="font-display text-3xl font-bold">Subscriptions</h1>
        <p className="mt-1 text-muted-foreground">
          Set a restaurant&apos;s package directly. Changes take effect immediately.
        </p>
      </header>
      <PlatformNav />

      <label className="relative mb-4 block">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search restaurants"
          className={`${INPUT_CLS} pl-9`}
        />
      </label>

      <div className="space-y-4">
        {filtered.map((row) => (
          <SubscriptionCard
            key={row.restaurant_id}
            row={row}
            catalog={catalog}
            defaultOpen={focusSlug === row.restaurant_slug.toLowerCase()}
          />
        ))}
        {filtered.length === 0 && (
          <p className="py-12 text-center text-muted-foreground">No restaurants match.</p>
        )}
      </div>
    </div>
  );
}

function SubscriptionCard({
  row,
  catalog,
  defaultOpen = false,
}: {
  row: RestaurantSubscriptionRow;
  catalog: BillingProduct[];
  defaultOpen?: boolean;
}) {
  const router = useRouter();
  const ent = row.entitlements;
  const [open, setOpen] = React.useState(defaultOpen);
  const [sel, setSel] = React.useState<PackageSelection>(() => currentSelection(ent));
  const [status, setStatus] = React.useState<Status>(
    (STATUSES as readonly string[]).includes(ent.status) ? (ent.status as Status) : 'active',
  );
  const [periodEnd, setPeriodEnd] = React.useState('');
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saved, setSaved] = React.useState(false);

  const addons = catalog.filter((p) => p.kind === 'addon');
  const plans = catalog.filter((p) => p.kind === 'plan');
  const total = packageMonthlyTotal(sel, catalog);
  const minSeats = Math.max(1, ent.branchesUsed);

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
      setError(res.error ?? 'Could not save.');
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
            {ent.entitled ? 'Live' : 'Suspended'}
          </Badge>
          <Badge variant="muted">{ent.planCode}</Badge>
          <Badge variant="outline">{ent.status}</Badge>
          {ent.addons.map((a) => (
            <Badge key={a} variant="default">
              {a}
            </Badge>
          ))}
        </div>
      </div>

      <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <Stat label="Monthly" value={money(ent.monthlyTotal)} />
        <Stat label="Seats" value={`${ent.branchesUsed} / ${ent.branchSeats}`} />
        <Stat
          label="Paid through"
          value={ent.entitledThrough ? date(ent.entitledThrough) : '—'}
        />
        <Stat label="Trial ends" value={ent.trialEndsAt ? date(ent.trialEndsAt) : '—'} />
      </dl>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="mt-3 text-sm text-primary underline-offset-2 hover:underline"
      >
        {open ? 'Close' : 'Change package'}
      </button>

      {open && (
        <div className="mt-4 space-y-4 border-t border-border pt-4">
          {error && (
            <p className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
              {error}
            </p>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Plan</span>
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
              <span className="mb-1 block text-xs font-medium text-muted-foreground">Status</span>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
                className={INPUT_CLS}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-medium text-muted-foreground">
                Paid through
              </span>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className={INPUT_CLS}
              />
              <span className="mt-1 block text-[11px] text-muted-foreground">
                Blank = +1 month (or +{catalog.find((p) => p.code === PLAN_TRIAL)?.trial_days ?? 14}{' '}
                days on trial).
              </span>
            </label>
          </div>

          <div>
            <span className="mb-2 block text-xs font-medium text-muted-foreground">Add-ons</span>
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
              <span className="text-xs font-medium text-muted-foreground">Branch seats</span>
              <button
                type="button"
                aria-label="Remove a seat"
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
                aria-label="Add a seat"
                onClick={() => setSel((s) => ({ ...s, branchSeats: Math.min(99, s.branchSeats + 1) }))}
                className="focus-ring grid h-9 w-9 place-items-center rounded-full border border-border"
              >
                <Plus className="h-4 w-4" />
              </button>
              {minSeats > 1 && (
                <span className="text-[11px] text-muted-foreground">
                  min {minSeats} (branches open)
                </span>
              )}
            </div>

            <p className="font-display text-xl font-bold">
              {money(total)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
            </p>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={save} loading={saving}>
              Apply package
            </Button>
            {saved && (
              <span className="flex items-center gap-1 text-sm text-success">
                <Check className="h-4 w-4" /> Saved
              </span>
            )}
          </div>
        </div>
      )}
    </Card>
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
