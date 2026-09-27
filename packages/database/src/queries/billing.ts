// Billing / entitlement queries.
//
// Read path  → get_entitlements / get_branch_entitlements (jsonb, SECURITY DEFINER).
// Write path → request_package_change (merchant, queues a request) and
//              billing_set_package (platform admin, applies it immediately).
//
// Every read here fails CLOSED: a network error, an RLS `forbidden`, an
// `auth_required` or a garbage payload all resolve to DENIED_ENTITLEMENTS.
// Returning null (as plan.ts does) would make callers fail OPEN, since
// `!status` reads the same as "no limits".

import {
  DENIED_ENTITLEMENTS,
  NOTHING_PAID,
  parseEntitlements,
  parseFeatureOverrides,
  type BillingPaidState,
  type BillingProduct,
  type Entitlements,
  type FeatureOverrideState,
  type PackageSelection,
} from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';
import { getSupabaseEnv } from '../env';

/** Branch seats are whole and never fewer than one, whatever a caller passes. */
function seatsOf(selection: PackageSelection): number {
  return Math.max(1, Math.trunc(selection.branchSeats || 1));
}

/** The chosen branches, each one once. The server re-checks they are this tenant's. */
function deliveryIdsOf(selection: PackageSelection): string[] {
  return [...new Set((selection.deliveryBranchIds ?? []).filter((id) => typeof id === 'string' && id))];
}

function num(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

// --- reads -------------------------------------------------------------------

/** Resolved entitlements for a restaurant. Never null, never throws. */
export async function getEntitlements(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<Entitlements> {
  if (!restaurantId) return DENIED_ENTITLEMENTS;
  try {
    const { data, error } = await supabase.rpc('get_entitlements', {
      p_restaurant_id: restaurantId,
    });
    if (error) return DENIED_ENTITLEMENTS;
    return parseEntitlements(data);
  } catch {
    return DENIED_ENTITLEMENTS;
  }
}

/** Same, keyed by branch — the shape every merchant surface has on hand. */
export async function getEntitlementsForBranch(
  supabase: FavornomsClient,
  branchId: string,
): Promise<Entitlements> {
  if (!branchId) return DENIED_ENTITLEMENTS;
  try {
    const { data, error } = await supabase.rpc('get_branch_entitlements', {
      p_branch_id: branchId,
    });
    if (error) return DENIED_ENTITLEMENTS;
    return parseEntitlements(data);
  } catch {
    return DENIED_ENTITLEMENTS;
  }
}

/**
 * What the storefront is allowed to render, for anonymous visitors.
 * Fails closed on an unknown branch (the RPC coalesces to all-false).
 */
export interface StorefrontStatus {
  /**
   * The RPC actually answered. False ONLY for STOREFRONT_UNKNOWN — a read that failed twice.
   *
   * Everything below fails closed, which is right for deciding what to OFFER but wrong for
   * deciding what to SAY. `delivery_entitled: false` from a real answer means "this branch
   * does not deliver", a permanent fact; from a failed read it means nothing at all, and a
   * storefront that prints the permanent sentence over a cold database tells the diners of a
   * branch that does deliver never to come back for delivery. Read this before wording any
   * "why not" line; never read it to widen what is on sale.
   */
  known: boolean;
  entitled: boolean;
  /** Delivery is sellable RIGHT NOW: the add-on is paid for AND the branch is inside
   *  its delivery window. The storefront's order-type picker no longer gates on this — every
   *  customer delivery is booked ahead, so it uses canScheduleDelivery (delivery_entitled and
   *  scheduling_enabled) instead. */
  delivery: boolean;
  /** The add-on is paid for, regardless of the clock. Kept separate so the storefront
   *  can say "delivery opens at 5pm" instead of hiding delivery as if it were never
   *  bought — two very different messages for a paying merchant. */
  delivery_entitled: boolean;
  /** Inside a delivery window (true whenever the hours feature is switched off). */
  delivery_available: boolean;
  /** Whether the merchant restricted delivery to set windows at all. */
  delivery_hours_on: boolean;
  /** 'platform' = dispatched to a rider; 'self' = the restaurant's own staff deliver,
   *  which means no live tracking map. */
  delivery_mode: 'platform' | 'self';
  delivery_windows: Array<{ day_of_week: number; opens_at: string; closes_at: string }>;
  card_payment: boolean;
  /** The branch's own Stripe account can take charges (private.branch_card_ready: its connected
   *  account has charges_enabled). The storefront offers card only when this AND card_payment
   *  are true; the account id itself is never part of this answer. */
  card_ready: boolean;
  /** The BRANCH's zone. Scheduling slots must be built in it, not in the phone's — a diner
   *  in California ordering from a Texas branch would otherwise be offered windows shifted
   *  two hours from the ones the kitchen actually keeps. */
  timezone: string;
  /** branch_hours, the same rows is_branch_open() checks. An EMPTY array means "no hours
   *  configured", which that function treats as always-open — not "closed all week". */
  opening_hours: Array<{ day_of_week: number; opens_at: string; closes_at: string }>;
  scheduling_enabled: boolean;
  /** Soonest a diner may schedule, in minutes from now. */
  schedule_min_lead_min: number;
  /** Furthest ahead a diner may schedule, in days. */
  schedule_max_days: number;
  /** Granularity of the offered time slots, in minutes. */
  schedule_slot_minutes: number;
}

const STOREFRONT_DENIED: StorefrontStatus = Object.freeze({
  // A caller with no branch id is not an outage: there is no branch, so "this branch does
  // not deliver" is the true sentence and the temporary one would be a lie.
  known: true,
  entitled: false,
  delivery: false,
  delivery_entitled: false,
  delivery_available: false,
  delivery_hours_on: false,
  delivery_mode: 'platform',
  delivery_windows: [],
  card_payment: false,
  card_ready: false,
  timezone: 'America/New_York',
  opening_hours: [],
  scheduling_enabled: false,
  schedule_min_lead_min: 15,
  schedule_max_days: 14,
  schedule_slot_minutes: 15,
});

/**
 * Used ONLY when the status could not be read at all (timeout, network, cold DB).
 *
 * `entitled` is true on purpose. A failed read is not evidence that the restaurant stopped
 * paying, but the old code treated it as such and rendered "This restaurant is not taking
 * orders right now" — telling a paying tenant's customers they were closed every time the
 * database hiccuped. That is a revenue-destroying false negative, and it happened in
 * production on a fully-entitled branch (entitled_through was a week away).
 *
 * Failing open is safe because entitlement is NOT enforced by this screen: BEFORE INSERT
 * triggers on orders/payments/deliveries reject writes from an unentitled restaurant at the
 * database, whatever the UI shows. So a genuinely lapsed tenant still cannot take an order —
 * they just get the error at submit instead of a polite wall.
 *
 * The two feature flags stay false: a wrong `true` there offers a diner a delivery or card
 * option the branch may not have, and losing an option for one render degrades far more
 * gracefully than losing the whole storefront.
 */
const STOREFRONT_UNKNOWN: StorefrontStatus = Object.freeze({
  // The one place this is false. The flags below stay closed — nothing is offered that we
  // cannot prove — but `known: false` lets a surface pick its words: "cannot be booked right
  // now" rather than "this branch does not deliver", which is the same failure this comment
  // describes for `entitled`, one sentence further down the page.
  known: false,
  entitled: true,
  delivery: false,
  delivery_entitled: false,
  delivery_available: false,
  delivery_hours_on: false,
  delivery_mode: 'platform',
  delivery_windows: [],
  card_payment: false,
  card_ready: false,
  timezone: 'America/New_York',
  opening_hours: [],
  // Same reasoning as the two feature flags above: on an unreadable status, offering a
  // scheduling UI built from hours we could not read is worse than not offering it.
  scheduling_enabled: false,
  schedule_min_lead_min: 15,
  schedule_max_days: 14,
  schedule_slot_minutes: 15,
});

/** jsonb numbers arrive as number; anything else (missing key, string, null) falls back. */
function numOr(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export async function getStorefrontStatus(
  supabase: FavornomsClient,
  branchId: string,
): Promise<StorefrontStatus> {
  // An absent branch id is a caller bug, not an outage — still denied.
  if (!branchId) return STOREFRONT_DENIED;

  // Two attempts: the overwhelming majority of failures here are a cold/slow database, and
  // a second try a moment later usually lands. Only a repeated failure is treated as unknown.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { data, error } = await supabase.rpc('storefront_status', { p_branch_id: branchId });
      if (!error && data && typeof data === 'object') {
        const d = data as Record<string, unknown>;
        // A successful read is authoritative, including a genuine `entitled: false`.
        return {
          known: true,
          entitled: d.entitled === true,
          delivery: d.delivery === true,
          // Older deployments of storefront_status did not return these keys. Defaulting
          // delivery_entitled to `delivery` keeps a stale function from making the
          // storefront claim delivery was never purchased.
          delivery_entitled: d.delivery_entitled === undefined
            ? d.delivery === true
            : d.delivery_entitled === true,
          delivery_available: d.delivery_available === undefined ? true : d.delivery_available === true,
          delivery_hours_on: d.delivery_hours_on === true,
          delivery_mode: d.delivery_mode === 'self' ? 'self' : 'platform',
          delivery_windows: Array.isArray(d.delivery_windows)
            ? (d.delivery_windows as StorefrontStatus['delivery_windows'])
            : [],
          card_payment: d.card_payment === true,
          // A storefront_status from before 20260925100000 has no key: no card online, which is
          // exactly what such a database can take (no connected accounts exist there).
          card_ready: d.card_ready === true,
          // Older deployments of storefront_status predate these keys. Defaulting
          // scheduling_enabled to true keeps a stale function from silently removing
          // "Schedule for later" from a storefront that has always had it; the server
          // still refuses anything outside the real policy.
          timezone: typeof d.timezone === 'string' && d.timezone ? d.timezone : 'America/New_York',
          opening_hours: Array.isArray(d.opening_hours)
            ? (d.opening_hours as StorefrontStatus['opening_hours'])
            : [],
          scheduling_enabled: d.scheduling_enabled === undefined ? true : d.scheduling_enabled === true,
          schedule_min_lead_min: numOr(d.schedule_min_lead_min, 15),
          schedule_max_days: numOr(d.schedule_max_days, 14),
          schedule_slot_minutes: numOr(d.schedule_slot_minutes, 15),
        };
      }
    } catch {
      // fall through to the retry / unknown
    }
    if (attempt === 0) await new Promise((r) => setTimeout(r, 250));
  }
  return STOREFRONT_UNKNOWN;
}

/** The sellable catalog. Empty array on error — a broken read must not price anything. */
export async function listBillingProducts(
  supabase: FavornomsClient,
  includeInactive = false,
): Promise<BillingProduct[]> {
  let q = supabase.from('billing_products').select('*').order('sort_order', { ascending: true });
  if (!includeInactive) q = q.eq('is_active', true);
  const { data, error } = await q;
  if (error || !data) return [];
  return (data as unknown[]).map(normalizeProduct);
}

function normalizeProduct(row: unknown): BillingProduct {
  const r = (row ?? {}) as Record<string, unknown>;
  const features: Record<string, boolean> = {};
  if (r.features && typeof r.features === 'object' && !Array.isArray(r.features)) {
    for (const [k, v] of Object.entries(r.features as Record<string, unknown>)) {
      if (v === true) features[k] = true;
    }
  }
  return {
    code: String(r.code ?? ''),
    name: String(r.name ?? r.code ?? ''),
    kind: String(r.kind ?? 'addon'),
    monthly_price: Number(r.monthly_price ?? 0),
    // A catalog read from a deployment that predates the one-time column prices
    // every one-time line at zero, which shows "nothing to pay" rather than a
    // number nobody agreed to. The server prices the purchase either way.
    one_time_price: Number(r.one_time_price ?? 0),
    included_seats: Number(r.included_seats ?? 0),
    seats_per_unit: Number(r.seats_per_unit ?? 0),
    trial_days: Number(r.trial_days ?? 0),
    is_quantity: r.is_quantity === true,
    features,
    stripe_price_id: typeof r.stripe_price_id === 'string' ? r.stripe_price_id : null,
    is_active: r.is_active !== false,
    sort_order: Number(r.sort_order ?? 0),
    description: typeof r.description === 'string' ? r.description : null,
  };
}

// --- the plan page's one read ------------------------------------------------

export interface BillingOverviewBranch {
  id: string;
  name: string;
  /** This branch delivers. Ignores the deadline, so a lapsed merchant still sees their switches. */
  deliveryActive: boolean;
  /** Its $59 was paid at some point, so switching it back on costs nothing one-time. */
  deliveryUnlocked: boolean;
}

export interface BillingCharge {
  id: string;
  code: string;
  branchId: string | null;
  amount: number;
  discountCode: string | null;
  discountAmount: number;
  netAmount: number;
  /**
   * 'paid' is bought. 'pending' is ON ORDER on the restaurant's open request — not bought: the
   * next request voids it and prices the fee afresh, and approval turns it paid. 'void' was
   * never agreed to.
   */
  status: 'pending' | 'paid' | 'void' | string;
  createdAt: string;
  /** The request that raised it; absent on a row backfilled from history. */
  requestId?: string | null;
  paidAt?: string | null;
}

export interface BillingCard {
  brand: string;
  last4: string;
  expMonth: number | null;
  expYear: number | null;
}

export interface BillingInvoiceSummary {
  amountPaid: number;
  amountDue: number;
  status: 'paid' | 'open' | 'uncollectible' | 'void' | string;
  paidAt: string | null;
  hostedInvoiceUrl: string | null;
  billingReason: string | null;
  attemptCount: number;
}

/**
 * How the restaurant pays the platform (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md).
 * `rail` is 'stripe' while it has a live Stripe subscription (billing_is_stripe_managed),
 * otherwise 'manual'. On the Stripe rail the monthly fee renews by itself.
 */
export interface BillingRailInfo {
  /** The platform has switched card billing on. */
  stripeEnabled: boolean;
  rail: 'stripe' | 'manual';
  status: string;
  /** A Stripe customer exists for the restaurant (it has paid by card before). */
  hasStripeCustomer: boolean;
  nextChargeAt: string | null;
  nextChargeAmount: number | null;
  cancelAtPeriodEnd: boolean;
  cancelAt: string | null;
  /** past_due only: the restaurant keeps working until then. */
  graceUntil: string | null;
  card: BillingCard | null;
  lastInvoice: BillingInvoiceSummary | null;
  /** The pending request's rail: 'stripe' means it is waiting for the card payment to finish. */
  pendingRequestRail: 'stripe' | 'manual' | null;
  /**
   * A change to a card subscription that is waiting on 3-D Secure or a declined card: Stripe's
   * invoice page where the merchant finishes paying it. While it is set the request cannot be
   * replaced (the server answers payment_in_progress).
   */
  pendingInvoiceUrl: string | null;
}

/** Manual, card billing off: what an unreadable or missing payload means. */
export const MANUAL_RAIL: BillingRailInfo = Object.freeze({
  stripeEnabled: false,
  rail: 'manual',
  status: 'none',
  hasStripeCustomer: false,
  nextChargeAt: null,
  nextChargeAmount: null,
  cancelAtPeriodEnd: false,
  cancelAt: null,
  graceUntil: null,
  card: null,
  lastInvoice: null,
  pendingRequestRail: null,
  pendingInvoiceUrl: null,
}) as BillingRailInfo;

function parseCard(raw: unknown): BillingCard | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const brand = str(c.brand);
  const last4 = str(c.last4);
  if (!brand || !last4) return null;
  const month = Math.trunc(num(c.exp_month, NaN));
  const year = Math.trunc(num(c.exp_year, NaN));
  return {
    brand,
    last4,
    expMonth: Number.isFinite(month) ? month : null,
    expYear: Number.isFinite(year) ? year : null,
  };
}

function parseInvoiceSummary(raw: unknown): BillingInvoiceSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const i = raw as Record<string, unknown>;
  return {
    amountPaid: num(i.amount_paid),
    amountDue: num(i.amount_due),
    status: String(i.status ?? ''),
    paidAt: str(i.paid_at),
    hostedInvoiceUrl: str(i.hosted_invoice_url),
    billingReason: str(i.billing_reason),
    attemptCount: Math.max(0, Math.trunc(num(i.attempt_count))),
  };
}

/** Parses the `billing` object of get_billing_overview / list_restaurant_subscriptions. Never throws. */
export function parseBillingRailInfo(raw: unknown): BillingRailInfo {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return MANUAL_RAIL;
  const b = raw as Record<string, unknown>;
  const amount = num(b.next_charge_amount, NaN);
  return {
    stripeEnabled: b.stripe_enabled === true,
    rail: b.rail === 'stripe' ? 'stripe' : 'manual',
    status: String(b.status ?? 'none'),
    hasStripeCustomer: b.stripe_customer === true,
    nextChargeAt: str(b.next_charge_at),
    nextChargeAmount: Number.isFinite(amount) ? amount : null,
    cancelAtPeriodEnd: b.cancel_at_period_end === true,
    cancelAt: str(b.cancel_at),
    graceUntil: str(b.grace_until),
    card: parseCard(b.card),
    lastInvoice: parseInvoiceSummary(b.last_invoice),
    pendingRequestRail:
      b.pending_request_rail === 'stripe' ? 'stripe' : b.pending_request_rail === 'manual' ? 'manual' : null,
    pendingInvoiceUrl: str(b.pending_invoice_url),
  };
}

export interface BillingOverview {
  entitlements: Entitlements;
  branches: BillingOverviewBranch[];
  /** What is PAID. A pending request's charges are not in here — see pendingRequest. */
  paid: BillingPaidState;
  /**
   * The restaurant's open request, if any: its one_time_total (net of the code), discount_code
   * and discount_amount are what the merchant will pay once when the platform approves it.
   */
  pendingRequest: BillingRequest | null;
  charges: BillingCharge[];
  /** How the restaurant pays: card through Stripe, or the manual rail. */
  billing: BillingRailInfo;
}

/** Denied, and denied in a way that sells nothing: no branch delivers, nothing is paid. */
const DENIED_OVERVIEW: BillingOverview = Object.freeze({
  entitlements: DENIED_ENTITLEMENTS,
  branches: [] as BillingOverviewBranch[],
  paid: NOTHING_PAID,
  pendingRequest: null,
  charges: [] as BillingCharge[],
  billing: MANUAL_RAIL,
}) as BillingOverview;

function parsePaidState(raw: unknown): BillingPaidState {
  const r = (raw ?? {}) as Record<string, unknown>;
  return {
    basePaid: r.base_paid === true,
    seatsPaid: Math.max(0, Math.trunc(num(r.seats_paid))),
    deliveryUnlockedBranchIds: Array.isArray(r.delivery_unlocked_branch_ids)
      ? r.delivery_unlocked_branch_ids.filter((b): b is string => typeof b === 'string')
      : [],
  };
}

/**
 * Everything the plan page needs: the entitlements, each branch with its delivery
 * state, what is already PAID, the open request with its one-time total, and the
 * one-time ledger with each charge's status.
 *
 * billing_charges has no merchant read policy at all — this RPC is the only way in.
 * Fails CLOSED: an unreadable overview must never read as "nothing is paid for, so
 * charge them again", which is why the denied value also has basePaid false and an
 * empty charge list. The server re-prices every purchase regardless.
 */
export async function getBillingOverview(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<BillingOverview> {
  if (!restaurantId) return DENIED_OVERVIEW;
  try {
    const { data, error } = await supabase.rpc('get_billing_overview', {
      p_restaurant_id: restaurantId,
    });
    if (error || !data || typeof data !== 'object') return DENIED_OVERVIEW;
    const d = data as Record<string, unknown>;
    return {
      entitlements: parseEntitlements(d.entitlements),
      branches: Array.isArray(d.branches)
        ? (d.branches as unknown[]).map((row) => {
            const b = (row ?? {}) as Record<string, unknown>;
            return {
              id: String(b.id ?? ''),
              name: String(b.name ?? ''),
              deliveryActive: b.delivery_active === true,
              deliveryUnlocked: b.delivery_unlocked === true,
            };
          })
        : [],
      paid: parsePaidState(d.paid),
      pendingRequest:
        d.pending_request && typeof d.pending_request === 'object' && !Array.isArray(d.pending_request)
          ? normalizeRequest(d.pending_request)
          : null,
      charges: Array.isArray(d.charges)
        ? (d.charges as unknown[]).map((row) => {
            const c = (row ?? {}) as Record<string, unknown>;
            return {
              id: String(c.id ?? ''),
              code: String(c.code ?? ''),
              branchId: str(c.branch_id),
              amount: num(c.amount),
              discountCode: str(c.discount_code),
              discountAmount: num(c.discount_amount),
              netAmount: num(c.net_amount),
              status: String(c.status ?? 'pending'),
              createdAt: String(c.created_at ?? ''),
              requestId: str(c.request_id),
              paidAt: str(c.paid_at),
            };
          })
        : [],
      billing: parseBillingRailInfo(d.billing),
    };
  } catch {
    return DENIED_OVERVIEW;
  }
}

// --- discount codes ----------------------------------------------------------

export interface BillingDiscountQuote {
  valid: boolean;
  /**
   * A reason code (DISCOUNT_REASONS), translated by discountReasonMessage(). Never shown raw.
   * 'rate_limited' means the restaurant made 10 unsuccessful code checks in 15 minutes; until
   * that window passes every check is refused, a good code included. Absent when the check
   * itself could not be made, which reads as "That code could not be applied."
   */
  reason?: string;
  /** The code's own description, for the merchant to recognise it by. */
  label?: string;
  oneTimeTotal: number;
  amountOff: number;
  netTotal: number;
}

/**
 * Price a code against a selection. The server does the arithmetic and returns the
 * amount; nothing here is ever sent back as a price. A failed read refuses the code
 * rather than granting a discount nobody validated.
 */
export async function validateBillingDiscount(
  supabase: FavornomsClient,
  args: { restaurantId: string; code: string; selection: PackageSelection },
): Promise<BillingDiscountQuote> {
  // A failed read carries no reason: "that code is not valid" would be a claim about a code
  // nobody looked at, and a merchant told that about a real code stops trying it.
  const denied: BillingDiscountQuote = {
    valid: false,
    oneTimeTotal: 0,
    amountOff: 0,
    netTotal: 0,
  };
  if (!args.restaurantId || !args.code.trim()) return { ...denied, reason: 'invalid_code' };
  try {
    const { data, error } = await supabase.rpc('validate_billing_discount', {
      p_restaurant_id: args.restaurantId,
      p_code: args.code.trim(),
      p_plan_code: args.selection.planCode,
      p_branch_seats: seatsOf(args.selection),
      p_delivery_branch_ids: deliveryIdsOf(args.selection),
    });
    if (error || !data || typeof data !== 'object') return denied;
    const d = data as Record<string, unknown>;
    return {
      valid: d.valid === true,
      reason: str(d.reason) ?? undefined,
      label: str(d.label) ?? undefined,
      oneTimeTotal: num(d.one_time_total),
      amountOff: num(d.amount_off),
      netTotal: num(d.net_total),
    };
  } catch {
    return denied;
  }
}

export interface DiscountCode {
  id: string;
  code: string;
  description: string | null;
  kind: 'percent' | 'fixed' | string;
  value: number;
  /** Empty means every one-time charge. */
  product_codes: string[];
  max_redemptions: number | null;
  redemption_count: number;
  per_restaurant_limit: number;
  starts_at: string;
  ends_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface DiscountRedemption {
  id: string;
  code_id: string;
  restaurant_id: string;
  restaurant_name: string | null;
  request_id: string | null;
  amount_off: number;
  /**
   * A use is taken when the merchant SUBMITS: 'reserved' while the request waits for the
   * platform, 'redeemed' once it is approved. Rejecting or replacing the request deletes a
   * reservation and gives the use back. Only 'redeemed' rows are money actually given away.
   */
  status: 'reserved' | 'redeemed' | string;
  redeemed_at: string;
}

export type DiscountCodeInput = Partial<Omit<DiscountCode, 'id' | 'redemption_count' | 'created_at' | 'updated_at'>> & {
  code: string;
  kind: 'percent' | 'fixed';
  value: number;
};

function normalizeDiscountCode(row: unknown): DiscountCode {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    code: String(r.code ?? ''),
    description: str(r.description),
    kind: String(r.kind ?? 'fixed'),
    value: num(r.value),
    product_codes: Array.isArray(r.product_codes)
      ? r.product_codes.filter((c): c is string => typeof c === 'string')
      : [],
    max_redemptions: r.max_redemptions === null || r.max_redemptions === undefined
      ? null
      : Math.trunc(num(r.max_redemptions)),
    redemption_count: Math.max(0, Math.trunc(num(r.redemption_count))),
    per_restaurant_limit: Math.max(1, Math.trunc(num(r.per_restaurant_limit, 1))),
    starts_at: String(r.starts_at ?? ''),
    ends_at: str(r.ends_at),
    is_active: r.is_active !== false,
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
  };
}

/** Platform admin only — the RPC refuses anyone else, and the table has no merchant policy. */
export async function listDiscountCodes(supabase: FavornomsClient): Promise<DiscountCode[]> {
  const { data, error } = await supabase.rpc('platform_list_discount_codes');
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map(normalizeDiscountCode);
}

/** Throws on refusal: a code the platform thinks it created but did not is worse than an error. */
export async function createDiscountCode(
  supabase: FavornomsClient,
  input: DiscountCodeInput,
): Promise<DiscountCode> {
  const { data, error } = await supabase.rpc('platform_create_discount_code', {
    p: input as unknown as Record<string, unknown>,
  });
  if (error) throw new Error(error.message);
  return normalizeDiscountCode(data);
}

/** Every key is optional: an absent one means "leave alone" server-side. */
export async function updateDiscountCode(
  supabase: FavornomsClient,
  id: string,
  patch: Partial<DiscountCodeInput>,
): Promise<DiscountCode> {
  const { data, error } = await supabase.rpc('platform_update_discount_code', {
    p_id: id,
    p: patch as unknown as Record<string, unknown>,
  });
  if (error) throw new Error(error.message);
  return normalizeDiscountCode(data);
}

export async function listDiscountRedemptions(
  supabase: FavornomsClient,
  codeId: string,
): Promise<DiscountRedemption[]> {
  const { data, error } = await supabase.rpc('platform_list_discount_redemptions', {
    p_code_id: codeId,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      code_id: String(r.code_id ?? ''),
      restaurant_id: String(r.restaurant_id ?? ''),
      restaurant_name: str(r.restaurant_name),
      request_id: str(r.request_id),
      amount_off: num(r.amount_off),
      // A row from before reservations existed was only ever written on approval.
      status: typeof r.status === 'string' ? r.status : 'redeemed',
      redeemed_at: String(r.redeemed_at ?? ''),
    };
  });
}

// --- merchant writes ---------------------------------------------------------

export interface BillingRequest {
  id: string;
  restaurant_id: string;
  requested_by: string | null;
  plan_code: string;
  /** Legacy. 'delivery' appears when any branch delivers; which ones is delivery_branch_ids. */
  addons: string[];
  branch_seats: number;
  /** $29 × branches + $29 × delivery branches. */
  monthly_total: number;
  /** The branches this request asks to deliver from. */
  delivery_branch_ids: string[];
  /** Payable once if approved, already net of discount_amount. */
  one_time_total: number;
  discount_code: string | null;
  discount_amount: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | string;
  note: string | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  /** 'stripe' once the merchant started paying it by card; such a request is never approved by hand. */
  rail: 'manual' | 'stripe';
  stripe_checkout_session_id: string | null;
  /**
   * A change to a card subscription waiting on this invoice (3-D Secure or a declined card), and
   * Stripe's page for paying it. While set, the request can be neither replaced nor rejected.
   */
  stripe_invoice_id: string | null;
  stripe_invoice_url: string | null;
  /**
   * When the request was tied to its invoice, and when a subscription change for it was sent to
   * Stripe. A card lock lasts 23 hours from the later of the two; after that the server releases it
   * on the next request or rejection (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §10.1).
   */
  stripe_invoice_marked_at: string | null;
  stripe_change_started_at: string | null;
  /** Set when a card payment settled it. */
  paid_at: string | null;
  /** Present only in the platform-admin list. */
  restaurant_name?: string;
  restaurant_slug?: string;
}

function normalizeRequest(row: unknown): BillingRequest {
  const r = (row ?? {}) as Record<string, unknown>;
  return {
    id: String(r.id ?? ''),
    restaurant_id: String(r.restaurant_id ?? ''),
    requested_by: str(r.requested_by),
    plan_code: String(r.plan_code ?? ''),
    addons: Array.isArray(r.addons) ? r.addons.filter((a): a is string => typeof a === 'string') : [],
    branch_seats: Math.max(1, Math.trunc(num(r.branch_seats, 1))),
    monthly_total: num(r.monthly_total),
    delivery_branch_ids: Array.isArray(r.delivery_branch_ids)
      ? r.delivery_branch_ids.filter((b): b is string => typeof b === 'string')
      : [],
    one_time_total: num(r.one_time_total),
    discount_code: str(r.discount_code),
    discount_amount: num(r.discount_amount),
    status: String(r.status ?? 'pending'),
    note: str(r.note),
    decision_note: str(r.decision_note),
    decided_by: str(r.decided_by),
    decided_at: str(r.decided_at),
    created_at: String(r.created_at ?? ''),
    updated_at: String(r.updated_at ?? ''),
    rail: r.rail === 'stripe' ? 'stripe' : 'manual',
    stripe_checkout_session_id: str(r.stripe_checkout_session_id),
    stripe_invoice_id: str(r.stripe_invoice_id),
    stripe_invoice_url: str(r.stripe_invoice_url),
    stripe_invoice_marked_at: str(r.stripe_invoice_marked_at),
    stripe_change_started_at: str(r.stripe_change_started_at),
    paid_at: str(r.paid_at),
    ...(typeof r.restaurant_name === 'string' ? { restaurant_name: r.restaurant_name } : {}),
    ...(typeof r.restaurant_slug === 'string' ? { restaurant_slug: r.restaurant_slug } : {}),
  };
}

/**
 * Queue a package change for platform approval. This is the live rail while
 * Stripe is dormant; once Stripe is configured the plan page routes to Checkout
 * instead and this stays as the fallback.
 *
 * The code is sent as a CODE, never as an amount: the server re-prices the monthly
 * total, the one-time total and the discount from the catalog and the PAID ledger,
 * replaces the restaurant's previous pending request, reserves one use of the code and
 * writes the pending billing_charges rows. Only billing.manage (the owner) may call it.
 *
 * It THROWS 'discount_invalid:<reason>' when the code cannot be used (or the guessing
 * limit is reached: 'discount_invalid:rate_limited') so the merchant is told which way
 * instead of being charged the full amount; describeBillingError() decodes that, and
 * every other refusal, into something readable. The RPC itself RETURNS that refusal as
 * { ok: false, reason } rather than raising it — a raise would roll back the failed
 * attempt the guessing limit counts — and nothing is filed or replaced when it does.
 */
export async function requestPackageChange(
  supabase: FavornomsClient,
  args: {
    restaurantId: string;
    selection: PackageSelection;
    discountCode?: string | null;
    note?: string | null;
  },
): Promise<BillingRequest> {
  const { data, error } = await supabase.rpc('request_package_change', {
    p_restaurant_id: args.restaurantId,
    p_plan_code: args.selection.planCode,
    p_branch_seats: seatsOf(args.selection),
    p_delivery_branch_ids: deliveryIdsOf(args.selection),
    p_discount_code: args.discountCode?.trim() ? args.discountCode.trim() : null,
    p_note: args.note ?? null,
  });
  if (error) throw new Error(error.message);
  const d = (data ?? {}) as Record<string, unknown>;
  if (d.ok === false) {
    throw new Error(`discount_invalid:${typeof d.reason === 'string' && d.reason ? d.reason : 'invalid_code'}`);
  }
  return normalizeRequest(data);
}

/** The restaurant's own pending request, if any. */
export async function getPendingBillingRequest(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<BillingRequest | null> {
  const { data, error } = await supabase.rpc('get_pending_billing_request', {
    p_restaurant_id: restaurantId,
  });
  if (error || !data || typeof data !== 'object') return null;
  return normalizeRequest(data);
}

/** Provision the 14-day trial. Idempotent — an existing subscription is left alone. */
export async function startTrial(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<Entitlements> {
  const { data, error } = await supabase.rpc('billing_start_trial', {
    p_restaurant_id: restaurantId,
  });
  if (error) return DENIED_ENTITLEMENTS;
  return parseEntitlements(data);
}

// --- platform-admin writes ---------------------------------------------------

export async function listBillingRequests(
  supabase: FavornomsClient,
  status: string | null = 'pending',
): Promise<BillingRequest[]> {
  const { data, error } = await supabase.rpc('list_billing_requests', { p_status: status });
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map(normalizeRequest);
}

export interface DecideResult {
  ok: boolean;
  approved?: boolean;
  entitlements?: Entitlements;
  error?: string;
}

export async function decideBillingRequest(
  supabase: FavornomsClient,
  id: string,
  approve: boolean,
  note?: string,
): Promise<DecideResult> {
  const { data, error } = await supabase.rpc('decide_billing_request', {
    p_id: id,
    p_approve: approve,
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const d = (data ?? {}) as Record<string, unknown>;
  // The refusals (stripe_managed, payment_in_progress) are raised today, but an answer of
  // { ok: false, reason } must not lose its reason on the way to the console either.
  const refusal = str(d.error) ?? str(d.reason);
  return {
    ok: d.ok === true,
    approved: d.approved === true,
    entitlements: d.entitlements ? parseEntitlements(d.entitlements) : undefined,
    ...(d.ok !== true && refusal ? { error: refusal } : {}),
  };
}

/**
 * Apply a package directly (platform admin only). This is the manual activation
 * rail: it is what actually turns a paying customer on while Stripe is dormant.
 *
 * It raises no one-time charge. What an operator grants by hand is not owed, and
 * the server counts the granted seats and the branch_addons rows it writes as
 * already bought, so the merchant is never asked to buy it a second time.
 */
export async function setRestaurantPackage(
  supabase: FavornomsClient,
  restaurantId: string,
  selection: PackageSelection,
  status: 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired' = 'active',
  periodEnd?: string | null,
): Promise<{ ok: boolean; entitlements?: Entitlements; error?: string }> {
  const { data, error } = await supabase.rpc('billing_set_package', {
    p_restaurant_id: restaurantId,
    p_plan_code: selection.planCode,
    p_branch_seats: seatsOf(selection),
    p_delivery_branch_ids: deliveryIdsOf(selection),
    p_status: status,
    p_period_end: periodEnd ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, entitlements: parseEntitlements(data) };
}

export interface RestaurantSubscriptionRow {
  restaurant_id: string;
  restaurant_name: string;
  restaurant_slug: string;
  created_at: string;
  entitlements: Entitlements;
  /** The platform switch, NOT the resolved grants. See featureOverrideState(). */
  feature_overrides: Record<string, boolean>;
  /** How it pays: card through Stripe, or manual. */
  billing: BillingRailInfo;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** past_due on the Stripe rail: the renewal Stripe is still trying to collect. */
  open_invoice: BillingInvoiceSummary | null;
}

export async function listRestaurantSubscriptions(
  supabase: FavornomsClient,
): Promise<RestaurantSubscriptionRow[]> {
  const { data, error } = await supabase.rpc('list_restaurant_subscriptions');
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      restaurant_id: String(r.restaurant_id ?? ''),
      restaurant_name: String(r.restaurant_name ?? ''),
      restaurant_slug: String(r.restaurant_slug ?? ''),
      created_at: String(r.created_at ?? ''),
      entitlements: parseEntitlements(r.entitlements),
      feature_overrides: parseFeatureOverrides(r.feature_overrides),
      billing: parseBillingRailInfo(r.billing),
      stripe_customer_id: str(r.stripe_customer_id),
      stripe_subscription_id: str(r.stripe_subscription_id),
      open_invoice: parseInvoiceSummary(r.open_invoice),
    };
  });
}

/**
 * Flip one feature for one restaurant, independently of its package.
 *
 * 'off' hides a feature the plan sold (the reason this exists: the trial grants
 * Digital Signage + AI Voice to everyone and both pages are still placeholders).
 * 'on' grants one the plan never sold. 'plan' clears the switch.
 *
 * The SQL recomputes billing_entitlements inside the same statement, so the
 * merchant sees the change on their next request — no cron, no cache purge.
 */
export async function setFeatureOverride(
  supabase: FavornomsClient,
  restaurantId: string,
  feature: string,
  state: FeatureOverrideState,
): Promise<{
  ok: boolean;
  overrides?: Record<string, boolean>;
  entitlements?: Entitlements;
  error?: string;
}> {
  const { data, error } = await supabase.rpc('platform_set_feature_override', {
    p_restaurant_id: restaurantId,
    p_feature: feature,
    p_state: state,
  });
  if (error) return { ok: false, error: error.message };
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    ok: d.ok === true,
    overrides: parseFeatureOverrides(d.feature_overrides),
    entitlements: d.entitlements ? parseEntitlements(d.entitlements) : undefined,
  };
}

/**
 * Create or patch a catalog row. Every field is optional and null means
 * "leave alone" server-side, so a partial save cannot clobber the features jsonb.
 */
export async function upsertBillingProduct(
  supabase: FavornomsClient,
  product: Partial<BillingProduct> & { code: string },
): Promise<{ ok: boolean; product?: BillingProduct; error?: string }> {
  const { data, error } = await supabase.rpc('upsert_billing_product', {
    p_code: product.code,
    p_name: product.name ?? null,
    p_kind: product.kind ?? null,
    p_monthly_price: product.monthly_price ?? null,
    p_included_seats: product.included_seats ?? null,
    p_seats_per_unit: product.seats_per_unit ?? null,
    p_trial_days: product.trial_days ?? null,
    p_is_quantity: product.is_quantity ?? null,
    p_features: product.features ?? null,
    p_stripe_price_id: product.stripe_price_id ?? null,
    p_is_active: product.is_active ?? null,
    p_sort_order: product.sort_order ?? null,
    p_description: product.description ?? null,
    p_one_time_price: product.one_time_price ?? null,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, product: normalizeProduct(data) };
}

// --- Stripe: restaurants paying the platform by card ------------------------
//
// docs/PLATFORM-BILLING-STRIPE-2026-09-26.md. Every call goes to the one edge function
// `stripe-billing`, which answers 503 { error: 'stripe_not_configured' } while the platform
// has not switched card billing on. That is not a failure: the request the merchant just
// filed stays a request for manual approval, exactly as before.

/** What an edge call answered: its JSON, or `dormant` while card billing is off. */
type EdgeAnswer = { dormant: true } | { dormant: false; body: Record<string, unknown> };

async function callStripeBilling(
  supabase: FavornomsClient,
  body: Record<string, unknown>,
): Promise<EdgeAnswer> {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new Error('not_signed_in');

  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/stripe-billing`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let parsed: Record<string, unknown> = {};
  try {
    const json: unknown = await res.json();
    if (json && typeof json === 'object' && !Array.isArray(json)) parsed = json as Record<string, unknown>;
  } catch {
    /* non-JSON body: a gateway page, handled below */
  }

  // Only the function's own answer means "switched off". A bare 503 from the gateway is an
  // outage, and an outage must not quietly turn a card payment into a manual request.
  if (res.status === 503 && parsed.error === 'stripe_not_configured') return { dormant: true };
  if (!res.ok) {
    const detail = typeof parsed.error === 'string' && parsed.error ? parsed.error : String(res.status);
    throw new Error(`stripe_billing_failed:${detail}`);
  }
  return { dormant: false, body: parsed };
}

/**
 * What taking payment for a filed request led to:
 * - `checkout`: send the browser to Stripe Checkout (`url`) — the restaurant's first card purchase.
 * - `applied`: the change was charged to the card on file and is live now.
 * - `action_required`: the card needs 3-D Secure or was declined; `url` is Stripe's invoice page.
 * - `dormant`: card billing is off; the request waits for manual approval.
 */
export type CardPaymentStart =
  | { kind: 'checkout'; url: string }
  | { kind: 'applied' }
  | { kind: 'action_required'; url: string }
  | { kind: 'dormant' };

export async function startCardPayment(
  supabase: FavornomsClient,
  requestId: string,
  branchId: string,
): Promise<CardPaymentStart> {
  const answer = await callStripeBilling(supabase, { action: 'start', request_id: requestId, branch_id: branchId });
  if (answer.dormant) return { kind: 'dormant' };
  const kind = answer.body.kind;
  const url = str(answer.body.url);
  if (kind === 'checkout' && url) return { kind: 'checkout', url };
  if (kind === 'action_required' && url) return { kind: 'action_required', url };
  if (kind === 'applied') return { kind: 'applied' };
  throw new Error('stripe_billing_failed:unexpected_answer');
}

/** After Stripe Checkout sends the merchant back: settles the request without waiting for the webhook. */
export async function confirmCheckout(
  supabase: FavornomsClient,
  sessionId: string,
): Promise<{ settled: boolean; status: string | null; reason: string | null }> {
  const answer = await callStripeBilling(supabase, { action: 'confirm', session_id: sessionId });
  if (answer.dormant) return { settled: false, status: 'dormant', reason: null };
  // `reason` tells a refund for a request that was replaced apart from one that could not be applied.
  return {
    settled: answer.body.settled === true,
    status: str(answer.body.status),
    reason: str(answer.body.reason),
  };
}

/** Stripe's customer portal (update card, invoices, cancel at period end). Null while card billing is off. */
export async function openBillingPortal(
  supabase: FavornomsClient,
  branchId: string,
): Promise<string | null> {
  const answer = await callStripeBilling(supabase, { action: 'portal', branch_id: branchId });
  if (answer.dormant) return null;
  const url = str(answer.body.url);
  if (!url) throw new Error('stripe_billing_failed:no_url');
  return url;
}

// --- Stripe: the platform owner's setup page ---------------------------------

export interface StripeBillingStatus {
  /** From the secret key's prefix; null when no key is set. */
  mode: 'test' | 'live' | null;
  secretKeySet: boolean;
  publishableKeySet: boolean;
  /** STRIPE_WEBHOOK_SECRET: the endpoint for package payments. */
  webhookSecretSet: boolean;
  /** STRIPE_CONNECT_WEBHOOK_SECRET: diners' card payments (Connect), shown for completeness. */
  connectWebhookSecretSet: boolean;
  /** The switch: packages are charged by card. */
  stripeEnabled: boolean;
  account: {
    id: string;
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
    detailsSubmitted: boolean;
    /** How many requirements Stripe says are due now. */
    currentlyDue: number;
    /** A bank account (or card) for payouts is on file. */
    hasBank: boolean;
  } | null;
  portalConfigured: boolean;
  pricesReady: boolean;
  lastEventAt: string | null;
  /** https://dashboard.stripe.com/<acct>/ plus test/ in test mode; links on the page append a path. */
  dashboardBase: string | null;
}

function parseStripeBillingStatus(b: Record<string, unknown>): StripeBillingStatus {
  const a = b.account && typeof b.account === 'object' ? (b.account as Record<string, unknown>) : null;
  return {
    mode: b.mode === 'test' || b.mode === 'live' ? b.mode : null,
    secretKeySet: b.secret_key_set === true,
    publishableKeySet: b.publishable_key_set === true,
    webhookSecretSet: b.webhook_secret_set === true,
    connectWebhookSecretSet: b.connect_webhook_secret_set === true,
    stripeEnabled: b.stripe_enabled === true,
    account: a
      ? {
          id: String(a.id ?? ''),
          chargesEnabled: a.charges_enabled === true,
          payoutsEnabled: a.payouts_enabled === true,
          detailsSubmitted: a.details_submitted === true,
          currentlyDue: Math.max(0, Math.trunc(num(a.currently_due))),
          hasBank: a.has_bank === true,
        }
      : null,
    portalConfigured: b.portal_configured === true,
    pricesReady: b.prices_ready === true,
    lastEventAt: str(b.last_event_at),
    dashboardBase: str(b.dashboard_base),
  };
}

/** Platform admin only. Booleans and ids, never a secret. Null while the function answers dormant. */
export async function getStripeBillingStatus(supabase: FavornomsClient): Promise<StripeBillingStatus | null> {
  const answer = await callStripeBilling(supabase, { action: 'status' });
  if (answer.dormant) return null;
  return parseStripeBillingStatus(answer.body);
}

/**
 * Platform admin only. Turning it on is refused (`stripe_billing_failed:not_ready`) until the
 * secret key and the webhook secret are set; the function prepares the prices and the customer
 * portal first. Returns the new status.
 */
export async function setStripeBillingEnabled(
  supabase: FavornomsClient,
  enabled: boolean,
): Promise<StripeBillingStatus | null> {
  const answer = await callStripeBilling(supabase, { action: 'set_enabled', enabled });
  if (answer.dormant) return null;
  return parseStripeBillingStatus(answer.body);
}

export interface PlatformBillingEvent {
  id: string;
  type: string;
  level: 'info' | 'warn' | 'error' | string;
  note: string | null;
  restaurantId: string | null;
  createdAt: string;
}

/** Package-payment events (Connect events excluded), newest first. Platform admin only. */
export async function listPlatformBillingEvents(
  supabase: FavornomsClient,
  restaurantId: string | null = null,
  limit = 50,
): Promise<PlatformBillingEvent[]> {
  const { data, error } = await supabase.rpc('platform_billing_events' as never, {
    p_restaurant_id: restaurantId,
    p_limit: limit,
  } as never);
  if (error || !Array.isArray(data)) return [];
  return (data as unknown[]).map((row) => {
    const r = (row ?? {}) as Record<string, unknown>;
    return {
      id: String(r.id ?? ''),
      type: String(r.type ?? ''),
      level: String(r.level ?? 'info'),
      note: str(r.note),
      restaurantId: str(r.restaurant_id),
      createdAt: String(r.created_at ?? ''),
    };
  });
}
