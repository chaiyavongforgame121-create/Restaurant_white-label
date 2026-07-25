// Entitlements — what a restaurant has actually paid for.
//
// The authority is public.billing_entitlements, one resolved row per restaurant,
// recomputed by private.billing_compute() on every billing write. Nothing here
// decides access on its own: the SQL triggers (orders / payments / deliveries /
// branches) are the real gate. This module exists so the UI and the server
// components agree with the database instead of guessing.
//
// Every function in this file fails CLOSED. A missing row, a missing key, a
// parse error or a lapsed deadline all read as "no".
//
// Pricing model locked 2026-07-25 — see docs/PACKAGING-2026-07-25.md.

export const FEATURE_KEYS = [
  'card_payment',
  'ai_menu_import',
  'delivery',
  'ai_suite',
  'digital_signage',
  'ai_voice',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Product codes seeded in public.billing_products. */
export const PLAN_BASE = 'base';
export const PLAN_TRIAL = 'trial';
export const PRODUCT_EXTRA_BRANCH = 'extra_branch';
export const ADDON_DELIVERY = 'delivery';
export const ADDON_AI_SUITE = 'ai_suite';

export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'cancelled'
  | 'expired'
  | 'none';

export interface Entitlements {
  restaurantId: string;
  /** 'base' | 'trial' | 'none' */
  planCode: string;
  status: SubscriptionStatus | string;
  /** entitledThrough is set and still in the future. */
  entitled: boolean;
  /** The deadline. Suspension is simply "null or in the past" — no flag, no cron. */
  entitledThrough: string | null;
  trialEndsAt: string | null;
  branchSeats: number;
  branchesUsed: number;
  monthlyTotal: number;
  /** RAW grants (what was bought). Use hasFeature(), which also checks the deadline. */
  features: Record<string, boolean>;
  addons: string[];
}

const NO_FEATURES: Record<string, boolean> = Object.freeze({});

/** The value every read path falls back to. Never grants anything. */
export const DENIED_ENTITLEMENTS: Entitlements = Object.freeze({
  restaurantId: '',
  planCode: 'none',
  status: 'none',
  entitled: false,
  entitledThrough: null,
  trialEndsAt: null,
  branchSeats: 0,
  branchesUsed: 0,
  monthlyTotal: 0,
  features: NO_FEATURES,
  addons: [] as string[],
}) as Entitlements;

function asNumber(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function asIsoOrNull(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Parse the jsonb returned by get_entitlements / get_branch_entitlements.
 * Never throws — anything unrecognised becomes DENIED_ENTITLEMENTS.
 */
export function parseEntitlements(raw: unknown): Entitlements {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return DENIED_ENTITLEMENTS;
  const r = raw as Record<string, unknown>;

  const features: Record<string, boolean> = {};
  const rawFeatures = r.features;
  if (rawFeatures && typeof rawFeatures === 'object' && !Array.isArray(rawFeatures)) {
    for (const [k, v] of Object.entries(rawFeatures as Record<string, unknown>)) {
      // Only an explicit `true` counts. Truthy strings do not.
      if (v === true) features[k] = true;
    }
  }

  const entitledThrough = asIsoOrNull(r.entitled_through);
  // Trust the server's own verdict when present, but re-derive it from the
  // deadline as well: a stale cached payload must not keep granting access.
  const deadlineOk = entitledThrough !== null && Date.parse(entitledThrough) > Date.now();
  const entitled = r.entitled === true && deadlineOk;

  return {
    restaurantId: typeof r.restaurant_id === 'string' ? r.restaurant_id : '',
    planCode: typeof r.plan_code === 'string' ? r.plan_code : 'none',
    status: typeof r.status === 'string' ? r.status : 'none',
    entitled,
    entitledThrough,
    trialEndsAt: asIsoOrNull(r.trial_ends_at),
    branchSeats: Math.max(0, Math.trunc(asNumber(r.branch_seats))),
    branchesUsed: Math.max(0, Math.trunc(asNumber(r.branches_used))),
    monthlyTotal: asNumber(r.monthly_total),
    features,
    addons: Array.isArray(r.addons) ? r.addons.filter((a): a is string => typeof a === 'string') : [],
  };
}

/** True only when the restaurant is paid up AND owns the feature. */
export function hasFeature(e: Entitlements | null | undefined, key: FeatureKey): boolean {
  if (!e || !e.entitled) return false;
  return e.features[key] === true;
}

/** Owns the feature, regardless of whether the subscription has lapsed. */
export function ownsFeature(e: Entitlements | null | undefined, key: FeatureKey): boolean {
  return e?.features[key] === true;
}

export function isEntitled(e: Entitlements | null | undefined): boolean {
  return e?.entitled === true;
}

export function isTrialing(e: Entitlements | null | undefined): boolean {
  return e?.status === 'trialing';
}

/** Whole days remaining in the trial (0 on the last day), or null if not trialing. */
export function trialDaysLeft(e: Entitlements | null | undefined): number | null {
  if (!e || !isTrialing(e)) return null;
  const ends = e.trialEndsAt ?? e.entitledThrough;
  if (!ends) return null;
  const ms = Date.parse(ends) - Date.now();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

/** A seat is free. Adding a branch beyond this is blocked until one is bought. */
export function canAddBranch(e: Entitlements | null | undefined): boolean {
  if (!e || !e.entitled) return false;
  return e.branchesUsed < e.branchSeats;
}

// --- catalog / pricing -------------------------------------------------------

export interface BillingProduct {
  code: string;
  name: string;
  kind: 'plan' | 'addon' | 'seat' | string;
  monthly_price: number;
  included_seats: number;
  seats_per_unit: number;
  trial_days: number;
  is_quantity: boolean;
  features: Record<string, boolean>;
  stripe_price_id: string | null;
  is_active: boolean;
  sort_order: number;
  description: string | null;
}

export interface PackageSelection {
  planCode: string;
  addons: string[];
  branchSeats: number;
}

export interface PackageLine {
  code: string;
  label: string;
  qty: number;
  unit: number;
  total: number;
}

function findProduct(catalog: BillingProduct[], code: string): BillingProduct | undefined {
  return catalog.find((p) => p.code === code);
}

/**
 * Expand a selection into billable lines. Mirrors private.billing_apply_selection
 * exactly — extra seats are (requested − plan.included_seats), never negative.
 */
export function packageLines(sel: PackageSelection, catalog: BillingProduct[]): PackageLine[] {
  const lines: PackageLine[] = [];
  const plan = findProduct(catalog, sel.planCode);
  if (!plan) return lines;

  lines.push({
    code: plan.code,
    label: plan.name,
    qty: 1,
    unit: plan.monthly_price,
    total: plan.monthly_price,
  });

  const seat = findProduct(catalog, PRODUCT_EXTRA_BRANCH);
  const extra = Math.max(Math.max(1, sel.branchSeats) - (plan.included_seats ?? 0), 0);
  if (seat && extra > 0) {
    lines.push({
      code: seat.code,
      label: seat.name,
      qty: extra,
      unit: seat.monthly_price,
      total: seat.monthly_price * extra,
    });
  }

  for (const code of sel.addons) {
    const addon = findProduct(catalog, code);
    if (!addon || addon.kind !== 'addon') continue;
    lines.push({
      code: addon.code,
      label: addon.name,
      qty: 1,
      unit: addon.monthly_price,
      total: addon.monthly_price,
    });
  }

  return lines;
}

export function packageMonthlyTotal(sel: PackageSelection, catalog: BillingProduct[]): number {
  return packageLines(sel, catalog).reduce((sum, l) => sum + l.total, 0);
}

/** Feature keys a selection would grant, before it is paid for. */
export function selectionFeatures(sel: PackageSelection, catalog: BillingProduct[]): Set<string> {
  const out = new Set<string>();
  for (const line of packageLines(sel, catalog)) {
    const product = findProduct(catalog, line.code);
    if (!product) continue;
    for (const [k, v] of Object.entries(product.features ?? {})) {
      if (v === true) out.add(k);
    }
  }
  return out;
}

/**
 * The selection a restaurant is currently on, for pre-filling the plan page.
 *
 * The trial is not a purchasable plan — it is granted once at signup and never
 * sold. Seeding the builder with `trial` would let a trialing merchant "buy"
 * $0/mo with every feature on, so a trial always pre-fills as Base instead.
 * Their add-ons carry over, because that is the feature set they are used to.
 */
export function currentSelection(e: Entitlements | null | undefined): PackageSelection {
  const plan = e?.planCode;
  const purchasable = plan && plan !== 'none' && plan !== PLAN_TRIAL;
  return {
    planCode: purchasable ? plan : PLAN_BASE,
    addons: e?.addons ? [...e.addons] : [],
    branchSeats: Math.max(1, e?.branchSeats ?? 1),
  };
}

// --- error decoding ----------------------------------------------------------

export type BillingError =
  | { kind: 'inactive'; scope: string }
  | { kind: 'feature'; feature: string }
  | { kind: 'seats'; current: number; limit: number }
  | { kind: 'dormant' };

/**
 * Decode the error contract raised by the SQL triggers (P0001) and returned by
 * the edge functions (402 / 403 / 503). Returns null for anything else.
 */
export function describeBillingError(err: unknown): BillingError | null {
  const msg =
    err instanceof Error
      ? err.message
      : typeof err === 'string'
        ? err
        : typeof err === 'object' && err !== null
          ? String(
              (err as { message?: unknown; error?: unknown }).message ??
                (err as { error?: unknown }).error ??
                '',
            )
          : '';
  if (!msg) return null;

  const seats = msg.match(/plan_limit_exceeded:branches:(\d+)\/(-?\d+)/);
  if (seats) return { kind: 'seats', current: Number(seats[1]), limit: Number(seats[2]) };

  const inactive = msg.match(/billing_inactive(?::([a-z_]+))?/);
  if (inactive) return { kind: 'inactive', scope: inactive[1] ?? 'account' };

  const feature = msg.match(/feature_not_entitled(?::([a-z_]+))?/);
  if (feature) return { kind: 'feature', feature: feature[1] ?? 'unknown' };

  if (/delivery_not_entitled/.test(msg)) return { kind: 'feature', feature: 'delivery' };
  if (/stripe_not_configured/.test(msg)) return { kind: 'dormant' };

  return null;
}

const FEATURE_LABELS: Record<string, string> = {
  card_payment: 'Card payment',
  ai_menu_import: 'AI menu import',
  delivery: 'Delivery',
  ai_suite: 'AI Suite',
  digital_signage: 'Digital Signage',
  ai_voice: 'AI Voice Assistant',
};

export function featureLabel(key: string): string {
  return FEATURE_LABELS[key] ?? key;
}

/** Human-readable copy for a decoded billing error. */
export function billingErrorMessage(e: BillingError): string {
  switch (e.kind) {
    case 'inactive':
      return 'Your subscription is not active. Choose a package to continue.';
    case 'feature':
      return `${featureLabel(e.feature)} is not included in your current package.`;
    case 'seats':
      return `You are using ${e.current} of ${e.limit} branch seats. Add a seat to create another branch.`;
    case 'dormant':
      return 'Online payment is not configured yet. Your request has been sent for manual activation.';
  }
}
