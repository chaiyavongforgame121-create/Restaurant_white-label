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
//
// Nothing here is worded: every label is a Msg — a key in the `platform` message
// namespace plus its values — and platform-text.ts turns it into the reader's
// language where it is rendered. Only the decisions live in this module.

import {
  DEFAULT_UI_LOCALE,
  PLAN_BASE,
  PLAN_TRIAL,
  intlLocaleFor,
  type Entitlements,
  type UiLocale,
} from '@favornoms/shared';

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

/** A value inside a message. `{ date }` is an ISO timestamp, formatted in the reader's language. */
export type MsgValue = string | number | { date: string | null };

/** A message in the `platform` namespace: the key plus the values it needs. */
export interface Msg {
  key: string;
  values?: Record<string, MsgValue>;
}

const msg = (key: string, values?: Record<string, MsgValue>): Msg => (values ? { key, values } : { key });

export type ChipVariant = 'success' | 'danger' | 'warning' | 'default' | 'outline' | 'muted';
export type ChipIcon = 'billing' | 'clock' | 'ban' | 'pause' | 'check';
export type Rail = 'danger' | 'warning' | 'none';

export interface HealthChip {
  label: Msg;
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
  clause: Msg;
  /** "3 branches" / "1 branch". */
  branchCount: Msg;
  /** "all live" / "1 suspended" / "2 paused". */
  branchQualifier: Msg;
  rail: Rail;
  /** suspended 4 · unpaid 3 · expiring 2 · partial 1 · live 0. Drives the default sort. */
  severity: 0 | 1 | 2 | 3 | 4;
  /** Billing or platform access is off. Named after what it proves, not "dark". */
  offline: boolean;
  /**
   * A paid (non-trial) store that is still live but whose paid-through date is
   * within EXPIRY_WARN_DAYS. Nothing renews by itself while Stripe is dormant, so
   * this is the cohort that goes dark next unless the platform owner extends it.
   */
  expiringSoon: boolean;
  /** Whole sentences, rendered in order; null when there is nothing to explain. */
  reason: Msg[] | null;
}

const DAY = 86_400_000;

/** How far ahead a paid store's deadline starts warning on /platform. */
export const EXPIRY_WARN_DAYS = 7;

/** A plan somebody pays for. The trial and "no subscription" are not extendable. */
export const isPaidPlan = (planCode: string) => planCode !== PLAN_TRIAL && planCode !== 'none';

/**
 * `ms + interval '1 month'` the way Postgres computes it: clamped to the last day
 * of the target month. JS setUTCMonth overflows instead (Jan 31 -> Mar 3), so a
 * naive date named a paid-through day the RPC would not write, on 7 calendar days
 * a year, for a money write.
 */
export function addOneMonthUtc(ms: number): Date {
  const d = new Date(ms);
  const startDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + 1);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(startDay, lastDay));
  return d;
}

const DATE_FMTS = new Map<UiLocale, Intl.DateTimeFormat>();

function dateFormat(locale: UiLocale): Intl.DateTimeFormat {
  let f = DATE_FMTS.get(locale);
  if (!f) {
    f = new Intl.DateTimeFormat(intlLocaleFor(locale), {
      timeZone: 'UTC',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
    DATE_FMTS.set(locale, f);
  }
  return f;
}

// Vercel runs the server in UTC and the operator's browser does not, so an
// unpinned toLocaleDateString() renders a different day on each side.
export const fmtDate = (v?: string | null, locale: UiLocale = DEFAULT_UI_LOCALE) =>
  v ? dateFormat(locale).format(new Date(v)) : '—';

export const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

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

  // Trials are excluded on purpose: their end is the conversion conversation, and
  // re-sending a trial plan would hand out another free period.
  const expiringSoon =
    entitled && isPaidPlan(ent.planCode) && ent.status !== 'trialing' && daysLeft <= EXPIRY_WARN_DAYS;

  const billing = billingChip(ent, row.cancelAtPeriodEnd, entitled, daysLeft, expiringSoon);
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
    clause: clauseFor(ent, entitled, daysLeft, total, active, row.cancelAtPeriodEnd, expiringSoon),
    branchCount: msg('health.branchCount', { count: total }),
    branchQualifier: qualifierFor(total, suspended, unpaid, paused),
    rail: platformSuspended || !entitled ? 'danger' : warned ? 'warning' : 'none',
    severity,
    offline: !entitled || platformSuspended,
    expiringSoon,
    reason: reasonFor(
      ent,
      entitled,
      daysLeft,
      total,
      active,
      paused,
      row.cancelAtPeriodEnd,
      expiringSoon,
    ),
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
  expiringSoon: boolean,
): HealthChip {
  if (!entitled) {
    return {
      label: msg(ent.status === 'expired' ? 'health.chip.expired' : 'health.chip.unpaid'),
      variant: 'danger',
      icon: 'billing',
    };
  }
  if (ent.status === 'trialing') {
    return {
      label: msg('health.chip.trial', { days: daysLeft }),
      variant: daysLeft <= 3 ? 'warning' : 'default',
      icon: 'clock',
    };
  }
  if (ent.status === 'past_due') {
    return { label: msg('health.chip.pastDue', { days: daysLeft }), variant: 'warning', icon: 'billing' };
  }
  if (ent.status === 'cancelled' || cancelAtPeriodEnd) {
    return { label: msg('health.chip.cancelling', { days: daysLeft }), variant: 'warning', icon: 'clock' };
  }
  // A green "Live" a few days before the deadline is how a paying store went dark
  // with nobody warned: the lamp only changed once diners were already turned away.
  if (expiringSoon) {
    return { label: msg('health.chip.expiresIn', { days: daysLeft }), variant: 'warning', icon: 'clock' };
  }
  return { label: msg('health.chip.live'), variant: 'success', icon: 'billing' };
}

function accessChip(total: number, active: number): HealthChip | null {
  if (total === 0 || active === total) return null;
  return active === 0
    ? { label: msg('health.chip.suspended'), variant: 'danger', icon: 'ban' }
    : {
        label: msg('health.chip.partlySuspended', { suspended: total - active, total }),
        variant: 'warning',
        icon: 'ban',
      };
}

function clauseFor(
  ent: Entitlements,
  entitled: boolean,
  daysLeft: number,
  total: number,
  active: number,
  cancelAtPeriodEnd: boolean,
  expiringSoon: boolean,
): Msg {
  // No branches means no storefront, so every diner-facing clause below would be
  // a claim about a page that does not exist. Say what is actually true instead.
  if (total === 0) return msg(entitled ? 'health.clause.noStorefront' : 'health.clause.noStorefrontUnpaid');

  const accessOff = total > 0 && active < total;
  if (accessOff && !entitled) return msg('health.clause.bothOff');
  if (accessOff) {
    return active === 0
      ? msg('health.clause.all404')
      : msg('health.clause.some404', { suspended: total - active, total });
  }
  if (!entitled) return msg('health.clause.suspendedScreen');
  if (ent.status === 'trialing') {
    return daysLeft <= 0
      ? msg('health.clause.trialEndsToday')
      : msg('health.clause.trialEndsIn', { days: daysLeft });
  }
  if (ent.status === 'past_due') return msg('health.clause.graceLeft', { days: daysLeft });
  if (ent.status === 'cancelled' || cancelAtPeriodEnd) {
    return msg('health.clause.ends', { date: { date: ent.entitledThrough } });
  }
  // Not "renews": nothing renews on its own while there is no payment rail, and
  // that word is what let an owner assume a store would carry on past its date.
  if (expiringSoon) return msg('health.clause.goesDark', { date: { date: ent.entitledThrough } });
  return msg('health.clause.paidThrough', { date: { date: ent.entitledThrough } });
}

// Counts, never names, so nothing here can be truncated.
function qualifierFor(total: number, suspended: number, unpaid: number, paused: number): Msg {
  if (total === 0) return msg('health.qualifier.nothingToServe');
  if (suspended > 0) return msg('health.qualifier.suspended', { count: suspended });
  if (unpaid > 0) return msg('health.qualifier.unpaid', { count: unpaid });
  if (paused > 0) return msg('health.qualifier.paused', { count: paused });
  return msg('health.qualifier.allLive');
}

function reasonFor(
  ent: Entitlements,
  entitled: boolean,
  daysLeft: number,
  total: number,
  active: number,
  paused: number,
  cancelAtPeriodEnd: boolean,
  expiringSoon: boolean,
): Msg[] | null {
  const parts: Msg[] = [];

  if (total > 0 && active === 0) {
    parts.push(msg('health.reason.allSuspended', { count: total }));
  } else if (total > 0 && active < total) {
    parts.push(msg('health.reason.someSuspended', { suspended: total - active, total }));
  }

  if (!entitled) {
    const lapsed = ent.entitledThrough ?? ent.trialEndsAt;
    // With no branches there is no storefront to be showing anything, so the
    // usual diner-facing sentence would be a fabrication.
    parts.push(
      lapsed
        ? msg(total === 0 ? 'health.reason.lapsedNoBranches' : 'health.reason.lapsedStorefront', {
            date: { date: lapsed },
          })
        : msg(
            total === 0
              ? 'health.reason.noSubscriptionNoBranches'
              : 'health.reason.noSubscriptionStorefront',
          ),
    );
    if (active > 0) {
      parts.push(msg('health.reason.accessFine'));
    }
  } else if (ent.status === 'trialing' && daysLeft <= 3) {
    parts.push(
      daysLeft <= 0
        ? msg('health.reason.trialEndsToday')
        : msg('health.reason.trialEndsIn', { days: daysLeft }),
    );
  } else if (ent.status === 'past_due') {
    parts.push(msg('health.reason.pastDue', { days: daysLeft }));
  } else if (expiringSoon && ent.status !== 'cancelled' && !cancelAtPeriodEnd) {
    // Never for a cancelling store: resolvePrimaryAction offers it no Extend, so
    // "unless you extend it" pointed the owner at a button that is not there.
    parts.push(msg('health.reason.expiring', { date: { date: ent.entitledThrough } }));
  }

  if (paused > 0) {
    parts.push(
      paused === total
        ? msg('health.reason.allPaused')
        : msg('health.reason.somePaused', { paused, total }),
    );
  }

  return parts.length > 0 ? parts : null;
}

// --- the one repair the row offers -------------------------------------------

export type PrimaryActionKind = 'restore' | 'extend' | 'convert';

export interface PrimaryAction {
  kind: PrimaryActionKind;
  label: Msg;
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
  if (health.total > 0 && health.active === 0) {
    return { kind: 'restore', label: msg('health.action.restore') };
  }
  if (health.entitled) {
    // Offered BEFORE the deadline, not only after it: waiting for the lapse meant
    // the button appeared once diners were already seeing the suspended screen.
    // A cancellation is left alone — extending it would silently undo a decision
    // somebody made on purpose.
    const cancelling = row.ent.status === 'cancelled' || row.cancelAtPeriodEnd;
    return health.expiringSoon && !cancelling
      ? { kind: 'extend', label: msg('health.action.extend') }
      : null;
  }
  if (isPaidPlan(row.ent.planCode)) {
    return { kind: 'extend', label: msg('health.action.extend') };
  }
  return {
    kind: 'convert',
    label:
      convertPrice === null
        ? msg('health.action.convert')
        : msg('health.action.convertPriced', { price: money(convertPrice) }),
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

/**
 * The paid-through date an Extend should send, or null to let the RPC use
 * now() + 1 month.
 *
 * billing_set_package with a blank period restarts the month from now(), so
 * extending a store paid through the 22nd on the 13th would have written the
 * 13th of next month and thrown away the nine days it had already paid for. While
 * the deadline is still ahead, the month is added to the deadline instead.
 */
export function extensionPeriodEnd(row: TenantRow, nowMs: number): string | null {
  const deadline = row.ent.entitledThrough ? Date.parse(row.ent.entitledThrough) : NaN;
  if (!Number.isFinite(deadline) || deadline <= nowMs) return null;
  return addOneMonthUtc(deadline).toISOString();
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
  label: Msg;
  variant: ChipVariant;
  icon: ChipIcon;
  /** The diner-visible symptom, not the internal cause. */
  hint: Msg;
  why: Msg;
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
      label: msg('health.verdict.label.suspended'),
      variant: 'danger',
      icon: 'ban',
      hint: msg('health.verdict.hint.suspended'),
      why: msg('health.verdict.why.suspended'),
    };
  }
  if (!branchEntitled(b, nowMs)) {
    return {
      key: 'unpaid',
      label: msg('health.verdict.label.unpaid'),
      variant: 'danger',
      icon: 'billing',
      hint: msg('health.verdict.hint.unpaid'),
      why: b.entitled_through
        ? msg('health.verdict.why.unpaidLapsed', { date: { date: b.entitled_through } })
        : msg('health.verdict.why.unpaidNone'),
    };
  }
  if (b.orders_paused) {
    return {
      key: 'paused',
      label: msg('health.verdict.label.paused'),
      variant: 'warning',
      icon: 'pause',
      hint: msg('health.verdict.hint.paused'),
      why: msg('health.verdict.why.paused'),
    };
  }
  if (b.closure) {
    return {
      key: 'closed',
      label: msg('health.verdict.label.closed'),
      variant: 'warning',
      icon: 'clock',
      hint: msg('health.verdict.hint.closure'),
      // The reason is what the merchant typed, so it is passed through untranslated.
      why: b.closure.reason
        ? msg('health.verdict.why.closureWithReason', {
            date: { date: b.closure.ends_at },
            reason: b.closure.reason,
          })
        : msg('health.verdict.why.closure', { date: { date: b.closure.ends_at } }),
    };
  }
  if (!b.has_hours) {
    return {
      key: 'live',
      label: msg('health.verdict.label.live'),
      variant: 'success',
      icon: 'check',
      hint: msg('health.verdict.hint.live'),
      why: msg('health.verdict.why.noHours'),
    };
  }
  if (openNow === null) return null;
  // A failed probe is NOT "Closed now". Reporting a network error as a closed
  // restaurant is the kind of confident wrong answer that sends an operator
  // chasing a branch's business hours when nothing is wrong with them.
  if (openNow === 'unknown') {
    return {
      key: 'unknown',
      label: msg('health.verdict.label.unknown'),
      variant: 'muted',
      icon: 'clock',
      hint: msg('health.verdict.hint.unknown'),
      why: msg('health.verdict.why.unknown'),
    };
  }
  return openNow
    ? {
        key: 'live',
        label: msg('health.verdict.label.live'),
        variant: 'success',
        icon: 'check',
        hint: msg('health.verdict.hint.live'),
        why: msg('health.verdict.why.open'),
      }
    : {
        key: 'closed',
        label: msg('health.verdict.label.closed'),
        variant: 'warning',
        icon: 'clock',
        hint: msg('health.verdict.hint.outsideHours'),
        why: msg('health.verdict.why.outsideHours', { timezone: b.timezone }),
      };
}

/**
 * is_branch_open() short-circuits to always-open when a branch has no hours, and
 * a more severe switch decides the verdict outright — so most branches need no
 * round trip at all.
 */
export const needsOpenProbe = (b: BranchLite, nowMs: number) =>
  b.is_active && branchEntitled(b, nowMs) && !b.orders_paused && !b.closure && b.has_hours;
