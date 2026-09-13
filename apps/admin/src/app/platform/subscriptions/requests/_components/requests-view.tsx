'use client';

// Merchant package-change queue.
//
// Approving calls decide_billing_request, which applies the package in the same
// transaction that marks the request approved — so the queue can never report
// "approved" for a package that failed to apply.
//
// Approving also REPLACES the whole package: billing_apply_selection deletes every
// line item the request does not name and restarts the month from now(). The card
// used to show only the request, so an old "Base, 3 seats" request read like an
// upgrade while it would have stripped Delivery and AI Suite from a store paying
// for both. Each pending card now shows what the store has today and what approving
// takes away, and a removal has to be confirmed by name.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  decideBillingRequest,
  type BillingRequest,
  type RestaurantSubscriptionRow,
} from '@favornoms/database/queries';
import {
  FEATURE_KEYS,
  featureLabel,
  packageMonthlyTotal,
  selectionFeatures,
  type BillingProduct,
  type PackageSelection,
} from '@favornoms/shared';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';
import { PlatformNav } from '../../../_components/platform-nav';
import { addOneMonthUtc, fmtDate } from '../../../_components/tenant-health';

const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

const DAY = 86_400_000;

const FILTERS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
] as const;

export function RequestsView({
  requests,
  status,
  packages,
  catalog,
  nowMs,
}: {
  requests: BillingRequest[];
  status: string;
  /** Each requesting restaurant's package today, keyed by restaurant id. A missing
   *  key means the read failed, not that the store has no package. */
  packages: Record<string, RestaurantSubscriptionRow>;
  /** The full catalog, inactive products included, priced the way the RPC prices. */
  catalog: BillingProduct[];
  /** The server clock, so dates render identically on both sides. */
  nowMs: number;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Package requests</h1>
        <p className="mt-1 text-muted-foreground">
          Merchants who chose a package and are waiting to be switched on.
        </p>
      </header>
      <PlatformNav />

      <div className="mb-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() =>
              router.push(`/platform/subscriptions/requests${f.value ? `?status=${f.value}` : ''}`)
            }
            className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              status === f.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {requests.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">Nothing here.</p>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <RequestCard
              key={r.id}
              request={r}
              current={packages[r.restaurant_id] ?? null}
              catalog={catalog}
              nowMs={nowMs}
              onError={setError}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({
  request,
  current,
  catalog,
  nowMs,
  onError,
}: {
  request: BillingRequest;
  current: RestaurantSubscriptionRow | null;
  catalog: BillingProduct[];
  nowMs: number;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const confirm = useConfirm();
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = React.useState('');

  const pending = request.status === 'pending';
  const name = request.restaurant_name ?? 'this restaurant';
  const diff = React.useMemo(
    () => (pending && current ? packageDiff(request, current, catalog, nowMs) : null),
    [pending, request, current, catalog, nowMs],
  );

  const decide = async (approve: boolean) => {
    if (approve) {
      const question = approvalQuestion(name, diff);
      if (question && !(await confirm(question))) return;
    }
    setBusy(approve ? 'approve' : 'reject');
    onError(null);
    const res = await decideBillingRequest(
      getBrowserClient(),
      request.id,
      approve,
      note.trim() || undefined,
    );
    setBusy(null);
    if (res.ok !== true) {
      onError(res.error ?? 'Could not save that decision.');
      return;
    }
    router.refresh();
  };

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">
            {request.restaurant_name ?? request.restaurant_id}
          </h2>
          <p className="text-xs text-muted-foreground">
            {new Date(request.created_at).toLocaleString('en-US')}
          </p>
        </div>
        <Badge
          variant={
            request.status === 'pending'
              ? 'warning'
              : request.status === 'approved'
                ? 'success'
                : 'muted'
          }
        >
          {request.status}
        </Badge>
      </div>

      {pending && (
        <p className="mt-3 text-xs uppercase tracking-wider text-muted-foreground">Requested</p>
      )}
      <div className={`${pending ? 'mt-1.5' : 'mt-3'} flex flex-wrap items-center gap-2 text-sm`}>
        <Badge variant="outline">{request.plan_code}</Badge>
        {(request.addons ?? []).map((a) => (
          <Badge key={a} variant="default">
            {a}
          </Badge>
        ))}
        <Badge variant="muted">
          {request.branch_seats} seat{request.branch_seats === 1 ? '' : 's'}
        </Badge>
        <span className="ml-auto font-display text-xl font-bold">
          {money(request.monthly_total)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
        </span>
      </div>

      {request.note && (
        <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm">{request.note}</p>
      )}
      {request.decision_note && (
        <p className="mt-3 text-sm text-muted-foreground">
          Decision note: {request.decision_note}
        </p>
      )}

      {pending &&
        (diff ? (
          <PackageComparison diff={diff} />
        ) : (
          <p className="mt-4 rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning">
            Could not load {name}&apos;s current package, so this card cannot show what approving
            removes. Approving replaces whatever they have now.
          </p>
        ))}

      {pending && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-10 min-w-[12rem] flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:border-primary"
          />
          <Button
            size="sm"
            loading={busy === 'approve'}
            disabled={busy !== null}
            onClick={() => decide(true)}
            leftIcon={<Check className="h-4 w-4" />}
          >
            Approve &amp; activate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'reject'}
            disabled={busy !== null}
            onClick={() => decide(false)}
            leftIcon={<X className="h-4 w-4" />}
          >
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}

function PackageComparison({ diff }: { diff: PackageDiff }) {
  const seatClass =
    diff.seatsTo < diff.seatsFrom ? 'text-danger' : diff.seatsTo > diff.seatsFrom ? 'text-success' : '';
  return (
    <div className="mt-4 space-y-3 border-t border-border pt-4 text-sm">
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Currently</p>
        <div className="mt-1.5 flex flex-wrap items-center gap-2">
          <Badge variant="outline">{diff.planFrom}</Badge>
          {diff.currentAddons.map((a) => (
            <Badge key={a} variant="default">
              {a}
            </Badge>
          ))}
          <Badge variant="muted">
            {diff.seatsFrom} seat{diff.seatsFrom === 1 ? '' : 's'}
          </Badge>
          <span className="ml-auto font-display text-lg font-bold">
            {money(diff.totalFrom)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
          </span>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          {diff.paidFrom
            ? `Paid through ${fmtDate(diff.paidFrom)}`
            : 'Not live — the storefront is dark right now'}
        </p>
      </div>

      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">Approving</p>
        <ul className="mt-1.5 space-y-1">
          {diff.removes.length > 0 && (
            <li className="font-semibold text-danger">This removes: {diff.removes.join(', ')}</li>
          )}
          {diff.adds.length > 0 && (
            <li className="font-semibold text-success">This adds: {diff.adds.join(', ')}</li>
          )}
          {diff.planFrom !== diff.planTo && (
            <li>
              Plan: {diff.planFrom} → {diff.planTo}
            </li>
          )}
          <li className={seatClass}>
            Seats:{' '}
            {diff.seatsFrom === diff.seatsTo
              ? `${diff.seatsTo} (no change)`
              : `${diff.seatsFrom} → ${diff.seatsTo}`}
          </li>
          <li>
            New total: <span className="font-semibold">{money(diff.totalTo)}/mo</span> (now{' '}
            {money(diff.totalFrom)}/mo)
            {diff.totalTo !== diff.requestedTotal &&
              ` · requested at ${money(diff.requestedTotal)}/mo, today's catalog prices apply`}
          </li>
          <li className={diff.daysLost > 0 ? 'text-danger' : ''}>
            Paid through: {diff.paidFrom ? fmtDate(diff.paidFrom) : 'lapsed'} →{' '}
            {fmtDate(diff.paidTo)}, counted from when you approve
            {diff.daysLost > 0 && ` (${diff.daysLost} paid days fewer)`}
          </li>
        </ul>
      </div>
    </div>
  );
}

interface PackageDiff {
  planFrom: string;
  planTo: string;
  currentAddons: string[];
  /** Add-on names and feature labels the store has now and will not have after. */
  removes: string[];
  adds: string[];
  seatsFrom: number;
  seatsTo: number;
  totalFrom: number;
  totalTo: number;
  requestedTotal: number;
  /** The current deadline, only while it is still ahead. */
  paidFrom: string | null;
  paidTo: string;
  daysLost: number;
}

function productName(catalog: BillingProduct[], code: string): string {
  return catalog.find((p) => p.code === code)?.name ?? featureLabel(code);
}

function planName(catalog: BillingProduct[], code: string): string {
  if (code === 'none') return 'No package';
  return catalog.find((p) => p.code === code)?.name ?? code;
}

function packageDiff(
  request: BillingRequest,
  current: RestaurantSubscriptionRow,
  catalog: BillingProduct[],
  nowMs: number,
): PackageDiff {
  const ent = current.entitlements;
  const requestedAddons = request.addons ?? [];
  const next: PackageSelection = {
    planCode: request.plan_code,
    addons: requestedAddons,
    branchSeats: Math.max(1, Math.trunc(request.branch_seats || 1)),
  };

  const removedAddons = ent.addons.filter((a) => !requestedAddons.includes(a));
  const addedAddons = requestedAddons.filter((a) => !ent.addons.includes(a));

  // Feature-level loss catches what the add-on list cannot: a trialing store has
  // every feature through the trial PLAN and no add-ons at all, so a Base request
  // switches off Delivery without removing a single add-on. Skipped when the
  // catalog did not load — every feature would then read as removed.
  let lostFeatures: string[] = [];
  let gainedFeatures: string[] = [];
  if (catalog.length > 0) {
    const after = selectionFeatures(next, catalog);
    // billing_compute applies the platform switch last, so an On/Off override
    // survives approval and must not be reported as a change.
    for (const [key, on] of Object.entries(current.feature_overrides)) {
      if (on) after.add(key);
      else after.delete(key);
    }
    const grantedBy = (codes: string[]) =>
      new Set(codes.flatMap((c) => Object.keys(catalog.find((p) => p.code === c)?.features ?? {})));
    // A removed add-on already names its own feature; listing both reads as two losses.
    const namedOut = grantedBy(removedAddons);
    const namedIn = grantedBy(addedAddons);
    lostFeatures = FEATURE_KEYS.filter(
      (k) => ent.features[k] === true && !after.has(k) && !namedOut.has(k),
    );
    gainedFeatures = FEATURE_KEYS.filter(
      (k) => ent.features[k] !== true && after.has(k) && !namedIn.has(k),
    );
  }

  // What billing_apply_selection writes on approval: start = now(), end = the
  // plan's trial length or now() + 1 month, whatever the store had before.
  const trialDays = catalog.find((p) => p.code === next.planCode)?.trial_days ?? 0;
  const paidTo = trialDays > 0 ? new Date(nowMs + trialDays * DAY) : addOneMonthUtc(nowMs);
  const deadline = ent.entitledThrough ? Date.parse(ent.entitledThrough) : NaN;
  const live = Number.isFinite(deadline) && deadline > nowMs;
  const daysLost = live ? Math.max(0, Math.floor((deadline - paidTo.getTime()) / DAY)) : 0;

  return {
    planFrom: planName(catalog, ent.planCode),
    planTo: planName(catalog, next.planCode),
    currentAddons: ent.addons.map((a) => productName(catalog, a)),
    removes: [...removedAddons.map((a) => productName(catalog, a)), ...lostFeatures.map(featureLabel)],
    adds: [...addedAddons.map((a) => productName(catalog, a)), ...gainedFeatures.map(featureLabel)],
    seatsFrom: ent.branchSeats,
    seatsTo: next.branchSeats,
    totalFrom: ent.monthlyTotal,
    totalTo:
      catalog.length > 0 ? packageMonthlyTotal(next, catalog) : Number(request.monthly_total ?? 0),
    requestedTotal: Number(request.monthly_total ?? 0),
    paidFrom: live ? ent.entitledThrough : null,
    paidTo: paidTo.toISOString(),
    daysLost,
  };
}

/** The question "Approve & activate" must ask first, or null when nothing is lost. */
function approvalQuestion(
  name: string,
  diff: PackageDiff | null,
): { title: string; body: string; confirmLabel: string; destructive: true } | null {
  if (!diff) {
    return {
      title: `Approve without seeing ${name}'s current package?`,
      body: 'Their current package could not be loaded. Approving replaces it entirely with this request, removing any add-on or seat the request does not include.',
      confirmLabel: 'Approve anyway',
      destructive: true,
    };
  }

  const losses: string[] = [];
  if (diff.removes.length > 0) losses.push(`removes ${diff.removes.join(', ')}`);
  if (diff.seatsTo < diff.seatsFrom) {
    losses.push(`cuts branch seats from ${diff.seatsFrom} to ${diff.seatsTo}`);
  }
  if (diff.daysLost > 0 && diff.paidFrom) {
    losses.push(
      `moves paid through back from ${fmtDate(diff.paidFrom)} to ${fmtDate(diff.paidTo)} (${diff.daysLost} days fewer)`,
    );
  }
  if (losses.length === 0) return null;

  return {
    title:
      diff.removes.length > 0
        ? `Approve and remove ${diff.removes.join(', ')}?`
        : 'Approve a smaller package?',
    body: `Approving replaces ${name}'s whole package with this request: it ${losses.join('; it ')}. They lose that as soon as you approve, and getting it back means setting the package again on Subscriptions.`,
    confirmLabel: 'Approve & remove',
    destructive: true,
  };
}
