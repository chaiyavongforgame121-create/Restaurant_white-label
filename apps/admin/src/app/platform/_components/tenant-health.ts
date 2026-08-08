// Two independent off-switches, derived once and shared by the index and the drawer.
//
// Billing (branches.entitled_through) shows the diner a suspended screen;
// branches.is_active shows them a 404. Neither implies the other, so a tenant
// gets one lamp per switch and the copy says which one to reach for.
//
// Everything here is driven by THE CLOCK, never by subscriptions.status:
// `billing-expire-tick` only runs every 10 minutes, so there is a recurring
// window where status is still 'active' while entitled_through has passed.
//
// The index deliberately claims only what this file can prove from the page
// query — billing and access. Whether a diner can order right now also depends
// on hours, closures and the kitchen pause; that verdict is per-branch, needs an
// is_branch_open() probe, and lives in the drawer.

import { PLAN_BASE, PLAN_TRIAL, type Entitlements } from '@favornoms/shared';

export interface BranchClosureLite {
  starts_at: string;
  ends_at: string;
  reason: string | null;
}

export interface BranchLite {
  id: string;
  restaurant_id: string;
  name: string;
  slug: string;
  is_active: boolean;
  orders_paused: boolean;
  /** Per-branch billing truth — the column the anon storefront actually reads. */
  entitled_through: string | null;
  timezone: string;
  custom_domain: string | null;
  has_hours: boolean;
  /** Only closures active right now; the page query filters the window server-side. */
  closure: BranchClosureLite | null;
}

export interface TenantRow {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  ent: Entitlements;
  franchise: boolean;
  loyaltyScope: string;
  cancelAtPeriodEnd: boolean;
}

export type ChipVariant = 'success' | 'danger' | 'warning' | 'default' | 'outline' | 'muted';
export type ChipIcon = 'billing' | 'clock' | 'ban' | 'pause' | 'check';
export type Rail = 'danger' | 'warning' | 'none';

export interface HealthChip {
  label: string;
  variant: ChipVariant;
  icon: ChipIcon;
}

export interface TenantHealth {
  entitled: boolean;
  daysLeft: number;
  total: number;
  active: number;
  paused: number;
  suspended: number;
  unpaid: number;
  billing: HealthChip;
  access: HealthChip | null;
  /** One lamp per tripped switch, most severe first. Never more than two, never zero. */
  lamps: [HealthChip, ...HealthChip[]];
  /** Short consequence clause rendered under the lamps. */
  clause: string;
  /** "3 branches" / "1 branch". */
  branchCount: string;
  /** "all live" / "1 suspended" / "2 paused". */
  branchQualifier: string;
  rail: Rail;
  /** suspended 4 · unpaid 3 · expiring 2 · partial 1 · live 0. Drives the default sort. */
  severity: 0 | 1 | 2 | 3 | 4;
  /** Billing or platform access is off. Named after what it proves, not "dark". */
  offline: boolean;
  reason: string | null;
}

const DAY = 86_400_000;

const DATE_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'UTC',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// Vercel runs the server in UTC and the operator's browser does not, so an
// unpinned toLocaleDateString() renders a different day on each side.
export const fmtDate = (v?: string | null) => (v ? DATE_FMT.format(new Date(v)) : '—');

export const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

const branchWord = (n: number) => (n === 1 ? 'branch' : 'branches');
const dayWord = (n: number) => (n === 1 ? 'day' : 'days');

export const branchEntitled = (b: BranchLite, nowMs: number) =>
  b.entitled_through !== null && Date.parse(b.entitled_through) > nowMs;

/**
 * Where a diner actually lands. A branch with a custom domain is served from
 * that host by the middleware and the /r/... path is not the URL any customer
 * ever sees, so linking there would show the operator a different page than the
 * one they are trying to check.
 */
export const storefrontUrl = (siteBase: string, restaurantSlug: string, b: BranchLite) =>
  b.custom_domain ? `https://${b.custom_domain}` : `${siteBase}/r/${restaurantSlug}/${b.slug}`;

// Lamps are read left-to-right and the first one is what the row's aria-label
// leads with, so the worst news has to come first. Without this a tenant whose
// billing has EXPIRED but which has one branch still suspended led with the
// warning-level access lamp and buried the danger-level billing one.
const CHIP_RANK: Record<ChipVariant, number> = {
  danger: 0,
  warning: 1,
  default: 2,
  outline: 3,
  muted: 4,
  success: 5,
};

export function tenantHealth(row: TenantRow, branches: BranchLite[], nowMs: number): TenantHealth {
  const { ent } = row;
  const deadline = ent.entitledThrough ? Date.parse(ent.entitledThrough) : NaN;
  const entitled = Number.isFinite(deadline) && deadline > nowMs;
  const daysLeft = Number.isFinite(deadline) ? Math.max(0, Math.ceil((deadline - nowMs) / DAY)) : 0;

  const total = branches.length;
  const active = branches.filter((b) => b.is_active).length;
  const paused = branches.filter((b) => b.orders_paused).length;
  const suspended = total - active;
  const unpaid = branches.filter((b) => !branchEntitled(b, nowMs)).length;

  const billing = billingChip(ent, row.cancelAtPeriodEnd, entitled, daysLeft);
  const access = accessChip(total, active);

  // Both switches off must show BOTH lamps — a single pill would hide one, and
  // the compound case is exactly the one an operator most needs to see whole.
  const lamps: [HealthChip, ...HealthChip[]] =
    access && !entitled
      ? ([access, billing].sort((x, y) => CHIP_RANK[x.variant] - CHIP_RANK[y.variant]) as [
          HealthChip,
          HealthChip,
        ])
      : access
        ? [access]
        : [billing];

  const platformSuspended = total > 0 && active === 0;
  const warned = billing.variant === 'warning' || access !== null || paused > 0;

  const severity: TenantHealth['severity'] = platformSuspended
    ? 4
    : !entitled
      ? 3
      : billing.variant === 'warning'
        ? 2
        : warned
          ? 1
          : 0;

  return {
    entitled,
    daysLeft,
    total,
    active,
    paused,
    suspended,
    unpaid,
    billing,
    access,
    lamps,
    clause: clauseFor(ent, entitled, daysLeft, total, active, row.cancelAtPeriodEnd),
    branchCount: total === 0 ? 'No branches' : `${total} ${branchWord(total)}`,
    branchQualifier: qualifierFor(total, suspended, unpaid, paused),
    rail: platformSuspended || !entitled ? 'danger' : warned ? 'warning' : 'none',
    severity,
    offline: !entitled || platformSuspended,
    reason: reasonFor(ent, entitled, daysLeft, total, active, paused),
  };
}

// past_due and cancelled are NOT off — billing_compute grants
// entitled_through = greatest(current_period_end, trial_ends_at) for both — so
// they warn rather than alarm. A naive status→label map reds a paying tenant.
function billingChip(
  ent: Entitlements,
  cancelAtPeriodEnd: boolean,
  entitled: boolean,
  daysLeft: number,
): HealthChip {
  if (!entitled) {
    return {
      label: ent.status === 'expired' ? 'Expired' : 'Unpaid',
      variant: 'danger',
      icon: 'billing',
    };
  }
  if (ent.status === 'trialing') {
    return {
      label: `Trial · ${daysLeft}d left`,
      variant: daysLeft <= 3 ? 'warning' : 'default',
      icon: 'clock',
    };
  }
  if (ent.status === 'past_due') {
    return { label: `Past due · ${daysLeft}d grace`, variant: 'warning', icon: 'billing' };
  }
  if (ent.status === 'cancelled' || cancelAtPeriodEnd) {
    return { label: `Cancelling · ${daysLeft}d`, variant: 'warning', icon: 'clock' };
  }
  return { label: 'Live', variant: 'success', icon: 'billing' };
}

function accessChip(total: number, active: number): HealthChip | null {
  if (total === 0 || active === total) return null;
  return active === 0
    ? { label: 'Suspended', variant: 'danger', icon: 'ban' }
    : { label: `${total - active} of ${total} suspended`, variant: 'warning', icon: 'ban' };
}

function clauseFor(
  ent: Entitlements,
  entitled: boolean,
  daysLeft: number,
  total: number,
  active: number,
  cancelAtPeriodEnd: boolean,
): string {
  // No branches means no storefront, so every diner-facing clause below would be
  // a claim about a page that does not exist. Say what is actually true instead.
  if (total === 0) return entitled ? 'No storefront yet' : 'No storefront yet · unpaid';

  const accessOff = total > 0 && active < total;
  if (accessOff && !entitled) return '404 + suspended screen';
  if (accessOff) return active === 0 ? 'Diners get a 404' : `${total - active} of ${total} branches 404`;
  if (!entitled) return 'Diners see the suspended screen';
  if (ent.status === 'trialing') {
    return daysLeft <= 0 ? 'Trial ends today' : `Trial ends in ${daysLeft} ${dayWord(daysLeft)}`;
  }
  if (ent.status === 'past_due') return `${daysLeft} ${dayWord(daysLeft)} of grace left`;
  if (ent.status === 'cancelled' || cancelAtPeriodEnd) return `Ends ${fmtDate(ent.entitledThrough)}`;
  return `renews ${fmtDate(ent.entitledThrough)}`;
}

// Counts, never names, so nothing here can be truncated.
function qualifierFor(total: number, suspended: number, unpaid: number, paused: number): string {
  if (total === 0) return 'nothing to serve';
  if (suspended > 0) return `${suspended} suspended`;
  if (unpaid > 0) return `${unpaid} unpaid`;
  if (paused > 0) return `${paused} paused`;
  return 'all live';
}

function reasonFor(
  ent: Entitlements,
  entitled: boolean,
  daysLeft: number,
  total: number,
  active: number,
  paused: number,
): string | null {
  const parts: string[] = [];

  if (total > 0 && active === 0) {
    parts.push(`All ${total} ${branchWord(total)} are platform-suspended, so the storefront returns 404.`);
  } else if (total > 0 && active < total) {
    parts.push(`${total - active} of ${total} branches are platform-suspended and return 404.`);
  }

  if (!entitled) {
    const lapsed = ent.entitledThrough ?? ent.trialEndsAt;
    // With no branches there is no storefront to be showing anything, so the
    // usual diner-facing sentence would be a fabrication.
    const symptom =
      total === 0
        ? 'this restaurant has no branches yet, so nothing is being served either way'
        : 'the storefront is showing the suspended screen';
    parts.push(
      lapsed
        ? `Subscription lapsed ${fmtDate(lapsed)} — ${symptom}.`
        : `No active subscription — ${symptom}.`,
    );
    if (active > 0) {
      parts.push('Platform access is fine, so Restore will not help; fix the subscription.');
    }
  } else if (ent.status === 'trialing' && daysLeft <= 3) {
    parts.push(daysLeft <= 0 ? 'Trial ends today.' : `Trial ends in ${daysLeft} ${dayWord(daysLeft)}.`);
  } else if (ent.status === 'past_due') {
    parts.push(`Payment is past due — ${daysLeft} ${dayWord(daysLeft)} of grace left.`);
  }

  if (paused > 0) {
    parts.push(
      paused === total
        ? 'Every branch is paused by the kitchen and is not taking orders.'
        : `${paused} of ${total} branches are paused by the kitchen.`,
    );
  }

  return parts.length > 0 ? parts.join(' ') : null;
}

// --- the one repair the row offers -------------------------------------------

export type PrimaryActionKind = 'restore' | 'extend' | 'convert';

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: string;
}

/**
 * The single repair worth putting on an index row, or null for a healthy tenant.
 * Because healthy rows stay button-free, the button itself becomes the alarm.
 *
 * Re-sending a `trial` plan would grant another free 14 days at $0/mo while
 * reading "active", so a lapsed trial converts to a paid plan instead.
 */
export function resolvePrimaryAction(
  row: TenantRow,
  health: TenantHealth,
  /**
   * What `conversionSelection` actually costs for THIS tenant, priced from the
   * catalog — not the bare Base price. Conversion keeps the add-ons the tenant
   * already owns and buys a seat per branch, so a flat "$199/mo" on the button
   * under-quoted every multi-branch or add-on tenant it was shown to.
   */
  convertPrice: number | null,
): PrimaryAction | null {
  if (health.total > 0 && health.active === 0) return { kind: 'restore', label: 'Restore' };
  if (health.entitled) return null;
  if (row.ent.planCode !== PLAN_TRIAL && row.ent.planCode !== 'none') {
    return { kind: 'extend', label: 'Extend 1 month' };
  }
  return {
    kind: 'convert',
    label: convertPrice === null ? 'Convert to Base' : `Convert to Base · ${money(convertPrice)}/mo`,
  };
}

/** The package a conversion would buy: Base, keeping the add-ons already owned. */
export function conversionSelection(row: TenantRow, branchesUsed: number) {
  return {
    planCode: PLAN_BASE,
    addons: [...row.ent.addons],
    branchSeats: Math.max(1, row.ent.branchSeats, row.ent.branchesUsed, branchesUsed),
  };
}

/** The package a tenant already has, re-billed from now(). */
export function renewalSelection(row: TenantRow, branchesUsed: number) {
  return {
    planCode: row.ent.planCode,
    addons: [...row.ent.addons],
    branchSeats: Math.max(1, row.ent.branchSeats, row.ent.branchesUsed, branchesUsed),
  };
}

// --- per-branch verdict (drawer only) ----------------------------------------

export type BranchVerdictKey = 'suspended' | 'unpaid' | 'paused' | 'closed' | 'live' | 'unknown';

/** The is_branch_open() answer: true/false, `'unknown'` if the probe failed, null while in flight. */
export type OpenNow = boolean | 'unknown' | null;

export interface BranchVerdict {
  key: BranchVerdictKey;
  label: string;
  variant: ChipVariant;
  icon: ChipIcon;
  /** The diner-visible symptom, not the internal cause. */
  hint: string;
  why: string;
}

/**
 * What a diner sees at this branch right now, most severe switch first.
 *
 * `openNow` is the answer from public.is_branch_open(): null while the probe is
 * in flight, `'unknown'` if it failed. The verdict is only null while a probe is
 * genuinely still running — every decided case returns a value without waiting,
 * and a failed probe says so rather than spinning forever.
 */
export function branchVerdict(
  b: BranchLite,
  nowMs: number,
  openNow: OpenNow,
): BranchVerdict | null {
  if (!b.is_active) {
    return {
      key: 'suspended',
      label: '404 — not found',
      variant: 'danger',
      icon: 'ban',
      hint: 'Platform-suspended — the storefront URL returns 404',
      why: 'Platform-suspended — resolveTenantBySlug filters is_active, so the URL 404s.',
    };
  }
  if (!branchEntitled(b, nowMs)) {
    return {
      key: 'unpaid',
      label: 'Suspended screen',
      variant: 'danger',
      icon: 'billing',
      hint: 'Subscription lapsed — the storefront shows the suspended screen',
      why: b.entitled_through
        ? `Subscription lapsed ${fmtDate(b.entitled_through)}.`
        : 'No active subscription for this branch.',
    };
  }
  if (b.orders_paused) {
    return {
      key: 'paused',
      label: 'Not taking orders',
      variant: 'warning',
      icon: 'pause',
      hint: 'Paused by the kitchen — the menu renders, order submit returns 409',
      why: 'The kitchen paused ordering. Only branch staff can unpause it.',
    };
  }
  if (b.closure) {
    return {
      key: 'closed',
      label: 'Closed now',
      variant: 'warning',
      icon: 'clock',
      hint: 'Temporarily closed — the menu renders, order submit returns 409',
      why: b.closure.reason
        ? `Temporarily closed until ${fmtDate(b.closure.ends_at)} — ${b.closure.reason}`
        : `Temporarily closed until ${fmtDate(b.closure.ends_at)}.`,
    };
  }
  if (!b.has_hours) {
    return {
      key: 'live',
      label: 'Live',
      variant: 'success',
      icon: 'check',
      hint: 'Serving diners',
      why: 'No business hours configured, so the branch is always open.',
    };
  }
  if (openNow === null) return null;
  // A failed probe is NOT "Closed now". Reporting a network error as a closed
  // restaurant is the kind of confident wrong answer that sends an operator
  // chasing a branch's business hours when nothing is wrong with them.
  if (openNow === 'unknown') {
    return {
      key: 'unknown',
      label: 'Hours unknown',
      variant: 'muted',
      icon: 'clock',
      hint: 'The business-hours check failed — everything else about this branch is fine',
      why: 'Could not reach is_branch_open(). Billing, access and the kitchen pause are all clear.',
    };
  }
  return openNow
    ? {
        key: 'live',
        label: 'Live',
        variant: 'success',
        icon: 'check',
        hint: 'Serving diners',
        why: 'Inside business hours and taking orders.',
      }
    : {
        key: 'closed',
        label: 'Closed now',
        variant: 'warning',
        icon: 'clock',
        hint: 'Outside business hours — the menu renders, order submit returns 409',
        why: `Outside business hours (${b.timezone}).`,
      };
}

/**
 * is_branch_open() short-circuits to always-open when a branch has no hours, and
 * a more severe switch decides the verdict outright — so most branches need no
 * round trip at all.
 */
export const needsOpenProbe = (b: BranchLite, nowMs: number) =>
  b.is_active && branchEntitled(b, nowMs) && !b.orders_paused && !b.closure && b.has_hours;
