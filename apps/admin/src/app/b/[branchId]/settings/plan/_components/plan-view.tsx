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
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  Minus,
  Plus,
  RotateCcw,
  Sparkles,
  XCircle,
} from 'lucide-react';
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
  formatInZone,
  isTrialing,
  packageLines,
  packageMonthlyTotal,
  trialDaysLeft,
  type BillingProduct,
  type Entitlements,
  type PackageSelection,
} from '@favornoms/shared';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';

/** The restaurant's most recent approved or rejected request, as the plan page shows it. */
export interface DecidedRequest {
  id: string;
  status: 'approved' | 'rejected';
  planCode: string;
  addons: string[];
  branchSeats: number;
  monthlyTotal: number;
  decisionNote: string | null;
  decidedAt: string;
}

interface Props {
  branchId: string;
  restaurantId: string;
  entitlements: Entitlements;
  catalog: BillingProduct[];
  pendingRequest: BillingRequest | null;
  latestDecision: DecidedRequest | null;
  /** The branch's zone, so a request "sent 9/12" means the merchant's 9/12. */
  timezone: string;
  suspended: boolean;
  /** An add-on code from `?add=`, already checked against the catalog. */
  preselectAddon: string | null;
  /** `?no_trial=1`: a second restaurant on an account that already used its trial. */
  noTrial: boolean;
  /** `?renew=1`: sent from the dashboard's expiry banner. */
  renew: boolean;
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;

function sameSelection(a: PackageSelection, b: PackageSelection): boolean {
  return (
    a.planCode === b.planCode &&
    a.branchSeats === b.branchSeats &&
    a.addons.length === b.addons.length &&
    a.addons.every((code) => b.addons.includes(code))
  );
}

/** "Base + Delivery, 2 branch seats" — what a request actually asks for, in catalog names. */
function describeSelection(sel: PackageSelection, catalog: BillingProduct[]): string {
  const name = (code: string) => catalog.find((p) => p.code === code)?.name ?? featureLabel(code);
  const parts = [name(sel.planCode), ...sel.addons.map(name)];
  return `${parts.join(' + ')}, ${sel.branchSeats} branch seat${sel.branchSeats === 1 ? '' : 's'}`;
}

export function PlanView({
  branchId,
  restaurantId,
  entitlements,
  catalog,
  pendingRequest,
  latestDecision,
  timezone,
  suspended,
  preselectAddon,
  noTrial,
  renew,
}: Props) {
  const router = useRouter();
  const confirm = useConfirm();
  const [sel, setSel] = React.useState<PackageSelection>(() => {
    const start = currentSelection(entitlements);
    // The upsell card that sent the merchant here already said which add-on they wanted;
    // making them find and tick it again is where that intent used to get lost.
    return preselectAddon && !start.addons.includes(preselectAddon)
      ? { ...start, addons: [...start.addons, preselectAddon] }
      : start;
  });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // What was just sent, held until router.refresh() brings the server's copy back. Without
  // it the button briefly re-arms against the OLD pending request and a second click
  // files the same request twice.
  const [queued, setQueued] = React.useState<PackageSelection | null>(null);
  // The refresh brings a new request id. Dropping the local copy then puts the banner back
  // on the stored row; without this it kept the copy for good and never showed the sent date.
  const pendingId = pendingRequest?.id ?? null;
  React.useEffect(() => {
    setQueued(null);
  }, [pendingId]);

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

  const serverPending: PackageSelection | null = pendingRequest
    ? {
        planCode: pendingRequest.plan_code,
        addons: Array.isArray(pendingRequest.addons) ? pendingRequest.addons : [],
        branchSeats: Number(pendingRequest.branch_seats ?? 1),
      }
    : null;
  const pending = queued ?? serverPending;
  const matchesPending = pending !== null && sameSelection(sel, pending);

  const toggleAddon = (code: string) => {
    setSel((s) => ({
      ...s,
      addons: s.addons.includes(code) ? s.addons.filter((a) => a !== code) : [...s.addons, code],
    }));
  };

  const setSeats = (n: number) => {
    setSel((s) => ({ ...s, branchSeats: Math.max(minSeats, Math.min(99, n)) }));
  };

  const submit = async () => {
    // request_package_change cancels the older pending request itself, so replacing is one
    // call. It is still asked about: the earlier request disappears from the platform
    // owner's queue, and that should not happen on a stray click.
    if (
      pending &&
      !(await confirm({
        title: 'Replace your pending request?',
        body: `Your earlier request (${describeSelection(pending, catalog)}) is withdrawn and this one goes to the Favornoms team instead.`,
        confirmLabel: 'Replace request',
      }))
    ) {
      return;
    }

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
      setQueued(sel);
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

  // One ladder for label and state, so the two cannot disagree. A pending request no
  // longer locks the page: an owner who asked for the wrong thing used to be stuck with it
  // until the platform owner happened to decide, and approving it could remove add-ons
  // they still pay for.
  const action: { label: string; enabled: boolean } = matchesPending
    ? { label: 'Request pending', enabled: false }
    : pending
      ? { label: 'Replace pending request', enabled: true }
      : suspended
        ? { label: noTrial ? 'Request activation' : 'Reactivate my account', enabled: true }
        : dirty
          ? { label: 'Confirm package', enabled: true }
          : renew
            ? { label: 'Request renewal', enabled: true }
            : { label: 'Current package', enabled: false };

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0 lg:pl-0">
        <h1 className="font-display text-3xl font-bold">Plan &amp; billing</h1>
        <p className="mt-1 text-muted-foreground">
          Choose what your restaurant runs on. Change it any time.
        </p>
      </header>

      {suspended && noTrial && <NoTrialBanner />}
      {suspended && !noTrial && <SuspendedBanner />}
      {!suspended && onTrial && <TrialBanner days={trialDays} />}
      {!suspended && !onTrial && renew && (
        <RenewBanner
          paidThrough={
            entitlements.entitledThrough
              ? formatInZone(entitlements.entitledThrough, timezone)
              : null
          }
        />
      )}

      {latestDecision && (
        <DecisionBanner decision={latestDecision} catalog={catalog} timezone={timezone} />
      )}

      {pending && (
        <PendingBanner
          summary={describeSelection(pending, catalog)}
          monthlyTotal={
            queued ? packageMonthlyTotal(queued, catalog) : Number(pendingRequest?.monthly_total ?? 0)
          }
          sentOn={
            !queued && pendingRequest?.created_at
              ? formatInZone(pendingRequest.created_at, timezone, { dateOnly: true })
              : null
          }
        />
      )}

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
                  disabled={sel.branchSeats <= minSeats}
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
                  disabled={sel.branchSeats >= 99}
                  onClick={() => setSeats(sel.branchSeats + 1)}
                  className="focus-ring grid h-10 w-10 place-items-center rounded-full border border-border disabled:opacity-40"
                >
                  <Plus className="h-4 w-4" />
                </button>
              </div>
            </div>
            {sel.branchSeats <= minSeats && entitlements.branchesUsed > 1 && (
              <p className="mt-3 text-xs text-muted-foreground">
                You run {entitlements.branchesUsed} active branches, so you cannot go below{' '}
                {minSeats} seats. To give up a seat, hide a branch you no longer use: open its
                Branch settings and set Status to Hidden. A hidden branch does not use a seat.
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
            disabled={!action.enabled}
            onClick={submit}
            leftIcon={<Sparkles className="h-4 w-4" />}
          >
            {action.label}
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
  onToggle,
}: {
  product: BillingProduct;
  selected: boolean;
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

/**
 * Onboarding sends a second restaurant here with ?no_trial=1. Without this the owner of a
 * brand-new store met "Your account is not active … everything comes straight back", which
 * describes a lapsed store and gives no hint why a new one never got its trial.
 */
function NoTrialBanner() {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-warning/15 px-4 py-3 text-sm">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
      <div>
        <p className="font-semibold">This restaurant starts without a free trial</p>
        <p className="text-muted-foreground">
          Your account already used its 14-day free trial on another restaurant. This one stays
          offline until it has a package: choose one below and send the request, and the Favornoms
          team activates it.
        </p>
      </div>
    </div>
  );
}

function RenewBanner({ paidThrough }: { paidThrough: string | null }) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-primary/10 px-4 py-3 text-sm">
      <RotateCcw className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
      <div>
        <p className="font-semibold">Renew your package</p>
        <p className="text-muted-foreground">
          {paidThrough ? `Your package is paid through ${paidThrough}. ` : ''}Your current package
          is selected below. Press Request renewal to send it to the Favornoms team — nothing
          renews until they approve it. You can also change the package before sending.
        </p>
      </div>
    </div>
  );
}

function DecisionBanner({
  decision,
  catalog,
  timezone,
}: {
  decision: DecidedRequest;
  catalog: BillingProduct[];
  timezone: string;
}) {
  const approved = decision.status === 'approved';
  const on = formatInZone(decision.decidedAt, timezone, { dateOnly: true });
  const summary = describeSelection(
    { planCode: decision.planCode, addons: decision.addons, branchSeats: decision.branchSeats },
    catalog,
  );
  return (
    <div
      className={`mb-4 flex items-start gap-3 rounded-xl px-4 py-3 text-sm ${
        approved ? 'bg-success/10' : 'bg-destructive/10'
      }`}
    >
      {approved ? (
        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" />
      ) : (
        <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
      )}
      <div className="min-w-0">
        <p className="font-semibold">
          {approved ? `Request approved on ${on}` : `Request declined on ${on}`}
        </p>
        <p className="text-muted-foreground">
          {summary} — {money(decision.monthlyTotal)}/mo.
        </p>
        {decision.decisionNote ? (
          <p className="mt-1 whitespace-pre-line break-words">
            <span className="font-medium">Note from the Favornoms team:</span>{' '}
            {decision.decisionNote}
          </p>
        ) : (
          !approved && (
            <p className="mt-1 text-muted-foreground">
              No reason was given. You can choose a package below and send a new request.
            </p>
          )
        )}
      </div>
      <Badge variant={approved ? 'success' : 'danger'} className="ml-auto shrink-0">
        {approved ? 'Approved' : 'Declined'}
      </Badge>
    </div>
  );
}

function PendingBanner({
  summary,
  monthlyTotal,
  sentOn,
}: {
  summary: string;
  monthlyTotal: number;
  sentOn: string | null;
}) {
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl bg-muted px-4 py-3 text-sm">
      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0">
        <p className="font-semibold">
          Request waiting for the Favornoms team{sentOn ? ` · sent ${sentOn}` : ''}
        </p>
        <p className="text-muted-foreground">
          {summary} — {money(monthlyTotal)}/mo. Nothing changes until it is approved. To ask for
          something else, change the package below and press Replace pending request.
        </p>
      </div>
      <Badge variant="warning" className="ml-auto shrink-0">
        Pending
      </Badge>
    </div>
  );
}
