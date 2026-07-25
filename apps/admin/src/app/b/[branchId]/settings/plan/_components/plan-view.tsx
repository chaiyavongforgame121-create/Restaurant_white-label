'use client';

// The package picker. This is the one merchant page that must stay reachable
// while suspended — it is the escape hatch, so the layout deliberately does not
// redirect away from it.
//
// Submit routes to Stripe Checkout when Stripe is configured and falls back to
// the manual request queue when it is not (the permanent state today). The
// fallback is not an error path: `createBillingCheckoutSession` returns
// `{dormant:true}` on the 503 and we queue instead. No UI change is needed on
// the day the owner supplies keys.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Check, Clock, Lock, Minus, Plus, Sparkles } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  createBillingCheckoutSession,
  requestPackageChange,
  type BillingRequest,
} from '@favornoms/database/queries';
import {
  ADDON_AI_SUITE,
  PLAN_BASE,
  PRODUCT_EXTRA_BRANCH,
  currentSelection,
  featureLabel,
  isTrialing,
  packageLines,
  packageMonthlyTotal,
  trialDaysLeft,
  type BillingProduct,
  type Entitlements,
  type PackageSelection,
} from '@favornoms/shared';
import { Badge, Button, Card } from '@favornoms/ui';

interface Props {
  branchId: string;
  restaurantId: string;
  entitlements: Entitlements;
  catalog: BillingProduct[];
  pendingRequest: BillingRequest | null;
  suspended: boolean;
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

export function PlanView({
  branchId,
  restaurantId,
  entitlements,
  catalog,
  pendingRequest,
  suspended,
}: Props) {
  const router = useRouter();
  const [sel, setSel] = React.useState<PackageSelection>(() => currentSelection(entitlements));
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [queued, setQueued] = React.useState<string | null>(null);

  const locked = pendingRequest !== null || queued !== null;

  const base = catalog.find((p) => p.code === PLAN_BASE);
  const seat = catalog.find((p) => p.code === PRODUCT_EXTRA_BRANCH);
  const addons = catalog.filter((p) => p.kind === 'addon');

  // A seat can never be dropped below the branches already open — the trigger
  // would refuse the write anyway, so refusing it here keeps the total honest.
  const minSeats = Math.max(1, entitlements.branchesUsed);
  const lines = packageLines(sel, catalog);
  const total = packageMonthlyTotal(sel, catalog);
  const trialDays = trialDaysLeft(entitlements);
  const onTrial = isTrialing(entitlements);

  const toggleAddon = (code: string) => {
    if (locked) return;
    setSel((s) => ({
      ...s,
      addons: s.addons.includes(code) ? s.addons.filter((a) => a !== code) : [...s.addons, code],
    }));
  };

  const setSeats = (n: number) => {
    if (locked) return;
    setSel((s) => ({ ...s, branchSeats: Math.max(minSeats, Math.min(99, n)) }));
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const origin = `${window.location.origin}/b/${branchId}/settings/plan`;

      // Stripe first; dormant is expected and falls through to the queue.
      const checkout = await createBillingCheckoutSession(supabase, restaurantId, sel, {
        successUrl: `${origin}?checkout=success`,
        cancelUrl: `${origin}?checkout=cancelled`,
      });
      if ('url' in checkout) {
        window.location.href = checkout.url;
        return;
      }

      const res = await requestPackageChange(supabase, restaurantId, sel);
      if (res.ok !== true) {
        setError(res.error ?? 'Could not send your request. Please try again.');
        return;
      }
      setQueued(res.request_id ?? 'sent');
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const dirty =
    sel.planCode !== entitlements.planCode ||
    sel.branchSeats !== entitlements.branchSeats ||
    sel.addons.length !== entitlements.addons.length ||
    sel.addons.some((a) => !entitlements.addons.includes(a));

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">Plan &amp; billing</h1>
        <p className="mt-1 text-muted-foreground">
          Choose what your restaurant runs on. Change it any time.
        </p>
      </header>

      {suspended && <SuspendedBanner />}
      {!suspended && onTrial && <TrialBanner days={trialDays} />}

      {(pendingRequest || queued) && <PendingBanner request={pendingRequest} />}

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[1fr_20rem] lg:items-start">
        <div className="space-y-4">
          {/* Base — always included, not a choice. */}
          <Card className="border-primary/40 p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <div>
                <h2 className="font-display text-xl font-bold">{base?.name ?? 'Base'}</h2>
                <p className="text-sm text-muted-foreground">
                  {base?.description ?? 'Everything you need to run one branch.'}
                </p>
              </div>
              <p className="font-display text-2xl font-bold">
                {money(base?.monthly_price ?? 199)}
                <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
              </p>
            </div>
            <ul className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
              <Included>Card payment at checkout</Included>
              <Included>AI menu import</Included>
              <Included>Online ordering &amp; QR</Included>
              <Included>Kitchen display &amp; counter</Included>
              <Included>Reports &amp; loyalty</Included>
              <Included>1 branch included</Included>
            </ul>
          </Card>

          {/* Add-ons */}
          <div className="grid gap-4 sm:grid-cols-2">
            {addons.map((addon) => (
              <AddonCard
                key={addon.code}
                product={addon}
                selected={sel.addons.includes(addon.code)}
                disabled={locked}
                onToggle={() => toggleAddon(addon.code)}
              />
            ))}
          </div>

          {/* Branch seats */}
          <Card className="p-5">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <h3 className="font-display text-lg font-bold">Branches</h3>
                <p className="text-sm text-muted-foreground">
                  1 included. Each extra branch is {money(seat?.monthly_price ?? 99)}/mo with the
                  full feature set of your main branch.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Using {entitlements.branchesUsed} of {entitlements.branchSeats} seat
                  {entitlements.branchSeats === 1 ? '' : 's'}.
                </p>
              </div>
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="Remove a branch seat"
                  disabled={locked || sel.branchSeats <= minSeats}
                  onClick={() => setSeats(sel.branchSeats - 1)}
                  className="focus-ring grid h-10 w-10 place-items-center rounded-full border border-border disabled:opacity-40"
                >
                  <Minus className="h-4 w-4" />
                </button>
                <span className="w-8 text-center font-display text-2xl font-bold tabular-nums">
                  {sel.branchSeats}
                </span>
                <button
                  type="button"
                  aria-label="Add a branch seat"
                  disabled={locked || sel.branchSeats >= 99}
                  onClick={() => setSeats(sel.branchSeats + 1)}
                  className="focus-ring grid h-10 w-10 place-items-center rounded-full border border-border disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            {sel.branchSeats <= minSeats && entitlements.branchesUsed > 1 && (
              <p className="mt-3 text-xs text-muted-foreground">
                You already run {entitlements.branchesUsed} branches, so you cannot go below{' '}
                {minSeats} seats. Close a branch first.
              </p>
            )}
          </Card>
        </div>

        {/* Summary */}
        <Card className="p-5 lg:sticky lg:top-6">
          <h3 className="font-display text-lg font-bold">Your package</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {lines.map((l) => (
              <li key={l.code} className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">
                  {l.label}
                  {l.qty > 1 && <span className="ml-1 text-xs">× {l.qty}</span>}
                </span>
                <span className="tabular-nums">{money(l.total)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-baseline justify-between border-t border-border pt-3">
            <span className="font-semibold">Total</span>
            <span className="font-display text-2xl font-bold tabular-nums">
              {money(total)}
              <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
            </span>
          </div>

          {onTrial && (
            <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
              You are on the free trial. Nothing is charged until it ends.
            </p>
          )}

          <Button
            variant="gradient"
            fullWidth
            className="mt-4"
            loading={busy}
            disabled={locked || (!dirty && !suspended)}
            onClick={submit}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            {locked
              ? 'Request pending'
              : suspended
                ? 'Reactivate my account'
                : dirty
                  ? 'Confirm package'
                  : 'Current package'}
          </Button>

          <p className="mt-3 text-xs text-muted-foreground">
            Your request goes to the Favornoms team for activation. You will be invoiced monthly.
          </p>
        </Card>
      </div>
    </div>
  );
}

function AddonCard({
  product,
  selected,
  disabled,
  onToggle,
}: {
  product: BillingProduct;
  selected: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const featureKeys = Object.keys(product.features ?? {});
  return (
    <Card
      className={`flex flex-col p-5 transition-colors ${
        selected ? 'border-primary bg-primary/[0.03]' : ''
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{product.name}</h3>
        <p className="font-display text-xl font-bold">
          +{money(product.monthly_price)}
          <span className="ml-0.5 text-xs font-normal text-muted-foreground">/mo</span>
        </p>
      </div>
      {product.description && (
        <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
      )}
      <ul className="mt-3 flex-1 space-y-1.5 text-sm">
        {featureKeys.map((k) => (
          <Included key={k}>{featureLabel(k)}</Included>
        ))}
      </ul>
      {product.code === ADDON_AI_SUITE && (
        <p className="mt-2 text-xs text-muted-foreground">Signage &amp; AI Voice — coming soon.</p>
      )}
      <Button
        variant={selected ? 'soft' : 'outline'}
        fullWidth
        size="sm"
        className="mt-4"
        disabled={disabled}
        onClick={onToggle}
        aria-pressed={selected}
      >
        {selected ? 'Added' : 'Add'}
      </Button>
    </Card>
  );
}

function Included({ children }: { children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      <span>{children}</span>
    </li>
  );
}

function TrialBanner({ days }: { days: number | null }) {
  const urgent = days !== null && days <= 3;
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${
        urgent ? 'bg-warning/15 text-warning-foreground' : 'bg-primary/10 text-foreground'
      }`}
    >
      <Clock className={`mt-0.5 h-4 w-4 shrink-0 ${urgent ? 'text-warning' : 'text-primary'}`} />
      <div>
        <p className="font-semibold">
          {days === null
            ? 'Free trial active'
            : days === 0
              ? 'Your free trial ends today'
              : `${days} day${days === 1 ? '' : 's'} left in your free trial`}
        </p>
        <p className="text-muted-foreground">
          Everything is unlocked. Choose a package below to keep it after the trial — no card needed
          until then.
        </p>
      </div>
    </div>
  );
}

function SuspendedBanner() {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-semibold">Your account is not active</p>
        <p className="opacity-90">
          Your storefront is offline and new orders are blocked. Nothing has been deleted — choose a
          package below and everything comes straight back.
        </p>
      </div>
    </div>
  );
}

function PendingBanner({ request }: { request: BillingRequest | null }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-muted px-4 py-3 text-sm">
      <Lock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div>
        <p className="font-semibold">Request sent</p>
        <p className="text-muted-foreground">
          {request
            ? `We received your request for ${money(Number(request.monthly_total ?? 0))}/mo and are activating it.`
            : 'We received your request and are activating it.'}{' '}
          You will not be able to change the package again until it is processed.
        </p>
      </div>
      <Badge variant="warning" className="ml-auto shrink-0">
        Pending
      </Badge>
    </div>
  );
}
