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
  parseEntitlements,
  parseFeatureOverrides,
  type BillingProduct,
  type Entitlements,
  type FeatureOverrideState,
  type PackageSelection,
} from '@favornoms/shared';
import type { FavornomsClient } from '../client-type';
import { getSupabaseEnv } from '../env';

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
  entitled: boolean;
  delivery: boolean;
  card_payment: boolean;
}

const STOREFRONT_DENIED: StorefrontStatus = Object.freeze({
  entitled: false,
  delivery: false,
  card_payment: false,
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
  entitled: true,
  delivery: false,
  card_payment: false,
});

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
          entitled: d.entitled === true,
          delivery: d.delivery === true,
          card_payment: d.card_payment === true,
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

// --- merchant writes ---------------------------------------------------------

export interface BillingRequest {
  id: string;
  restaurant_id: string;
  requested_by: string | null;
  plan_code: string;
  addons: string[];
  branch_seats: number;
  monthly_total: number;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled' | string;
  note: string | null;
  decision_note: string | null;
  decided_by: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
  /** Present only in the platform-admin list. */
  restaurant_name?: string;
  restaurant_slug?: string;
}

export interface RequestPackageChangeResult {
  ok: boolean;
  request_id?: string;
  monthly_total?: number;
  error?: string;
}

/**
 * Queue a package change for platform approval. This is the live rail while
 * Stripe is dormant; once Stripe is configured the plan page routes to Checkout
 * instead and this stays as the fallback.
 */
export async function requestPackageChange(
  supabase: FavornomsClient,
  restaurantId: string,
  selection: PackageSelection,
  note?: string,
): Promise<RequestPackageChangeResult> {
  const { data, error } = await supabase.rpc('request_package_change', {
    p_restaurant_id: restaurantId,
    p_plan_code: selection.planCode,
    p_addons: selection.addons,
    p_branch_seats: Math.max(1, Math.trunc(selection.branchSeats || 1)),
    p_note: note ?? null,
  });
  if (error) return { ok: false, error: error.message };
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    ok: d.ok === true,
    request_id: typeof d.request_id === 'string' ? d.request_id : undefined,
    monthly_total: Number(d.monthly_total ?? 0),
  };
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
  return data as unknown as BillingRequest;
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
  return data as unknown as BillingRequest[];
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
  return {
    ok: d.ok === true,
    approved: d.approved === true,
    entitlements: d.entitlements ? parseEntitlements(d.entitlements) : undefined,
  };
}

/**
 * Apply a package directly (platform admin only). This is the manual activation
 * rail: it is what actually turns a paying customer on while Stripe is dormant.
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
    p_addons: selection.addons,
    p_branch_seats: Math.max(1, Math.trunc(selection.branchSeats || 1)),
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
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true, product: normalizeProduct(data) };
}

// --- Stripe (dormant until the owner supplies keys) --------------------------

export type CheckoutResult = { url: string } | { dormant: true; reason: string };

function isDormant(body: unknown): boolean {
  const e = (body as { error?: unknown } | null)?.error;
  return e === 'stripe_not_configured';
}

async function callEdge(
  supabase: FavornomsClient,
  fn: string,
  body: unknown,
): Promise<CheckoutResult> {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new Error('not_signed_in');

  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/${fn}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  });

  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    /* non-JSON body — handled below */
  }

  // 503 + stripe_not_configured is the expected state today, not a failure:
  // the caller falls back to the manual request queue.
  if (res.status === 503 || isDormant(parsed)) {
    return { dormant: true, reason: 'stripe_not_configured' };
  }
  if (!res.ok) {
    const detail = (parsed as { error?: string } | null)?.error ?? String(res.status);
    throw new Error(`${fn}_failed:${detail}`);
  }
  const u = (parsed as { url?: unknown } | null)?.url;
  if (typeof u !== 'string' || !u) throw new Error(`${fn}_failed:no_url`);
  return { url: u };
}

export async function createBillingCheckoutSession(
  supabase: FavornomsClient,
  restaurantId: string,
  selection: PackageSelection,
  urls: { successUrl: string; cancelUrl: string },
): Promise<CheckoutResult> {
  return callEdge(supabase, 'stripe-create-checkout-session', {
    restaurant_id: restaurantId,
    selection: {
      plan_code: selection.planCode,
      addons: selection.addons,
      branch_seats: Math.max(1, Math.trunc(selection.branchSeats || 1)),
    },
    success_url: urls.successUrl,
    cancel_url: urls.cancelUrl,
  });
}

export async function openBillingPortal(
  supabase: FavornomsClient,
  restaurantId: string,
  returnUrl: string,
): Promise<CheckoutResult> {
  return callEdge(supabase, 'stripe-billing-portal', {
    restaurant_id: restaurantId,
    return_url: returnUrl,
  });
}
