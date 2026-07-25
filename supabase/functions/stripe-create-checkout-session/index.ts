// Stripe — Create a subscription Checkout Session (PLATFORM charges the RESTAURANT).
//
// B2B billing: the platform's own Stripe account collects a monthly subscription
// from each restaurant. This is SEPARATE from customer<->restaurant order payments
// (those restaurants collect themselves, into their own account).
//
// DORMANT until the owner supplies STRIPE_SECRET_KEY. Until then this returns
// 503 stripe_not_configured, and packages/database/src/queries/billing.ts turns
// that into {dormant:true} so the plan page silently falls back to the manual
// request queue. No UI change is needed at switch-on.
//
// Flow:
//   1. Owner opens /b/[branchId]/settings/plan and picks a package.
//   2. Client calls this fn (functions.invoke attaches the owner's JWT) with
//      {restaurant_id, selection:{plan_code, addons[], branch_seats}, ...urls}.
//   3. We verify the caller is the restaurant OWNER, resolve/create a Stripe
//      Customer, and open a Checkout Session in subscription mode with ONE LINE
//      ITEM PER PRODUCT (base + each add-on + the extra-branch seat quantity).
//   4. Client redirects to session.url. Stripe hosts the card entry.
//   5. stripe-webhook maps every line back through stripe_price_id and calls
//      stripe_sync_subscription(), which is the same SQL the manual rail uses.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

/** Pinned so payload shapes match what stripe-webhook parses. */
const STRIPE_API_VERSION = '2025-08-27.basil';

interface Selection {
  plan_code?: string;
  addons?: string[];
  branch_seats?: number;
}

interface Product {
  code: string;
  name: string;
  kind: string;
  included_seats: number;
  seats_per_unit: number;
  trial_days: number;
  stripe_price_id: string | null;
  is_active: boolean;
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405));
  if (!STRIPE_SECRET_KEY) return cors(json({ error: 'stripe_not_configured' }, 503));

  let body: {
    restaurant_id?: string;
    selection?: Selection;
    success_url?: string;
    cancel_url?: string;
  } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }

  const restaurantId = body.restaurant_id;
  const planCode = body.selection?.plan_code;
  if (!restaurantId || !planCode) {
    return cors(json({ error: 'restaurant_id_and_selection_required' }, 400));
  }
  const addons = Array.isArray(body.selection?.addons) ? body.selection!.addons! : [];
  const branchSeats = Math.max(1, Math.trunc(Number(body.selection?.branch_seats ?? 1)));

  // Authenticate the caller (owner JWT forwarded by functions.invoke).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));
  const userClient = createClient(SUPABASE_URL, authHeader.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user },
    error: userErr,
  } = await userClient.auth.getUser();
  if (userErr || !user) return cors(json({ error: 'invalid_token' }, 401));

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Owner-only, on this restaurant. Buying is not a manager action.
  const { data: staff } = await admin
    .from('staff_members')
    .select('id')
    .eq('user_id', user.id)
    .eq('restaurant_id', restaurantId)
    .eq('role', 'owner')
    .maybeSingle();
  if (!staff) return cors(json({ error: 'owner_only' }, 403));

  // Resolve the catalog from billing_products (NOT the legacy subscription_plans
  // table, whose 4-tier ladder no longer exists).
  const { data: catalogRows, error: catalogErr } = await admin
    .from('billing_products')
    .select('code, name, kind, included_seats, seats_per_unit, trial_days, stripe_price_id, is_active');
  if (catalogErr) return cors(json({ error: 'catalog_unavailable' }, 500));
  const catalog = new Map((catalogRows ?? []).map((p) => [p.code, p as Product]));

  const plan = catalog.get(planCode);
  if (!plan || !plan.is_active || plan.kind !== 'plan') {
    return cors(json({ error: 'unknown_plan', plan: planCode }, 404));
  }
  // The trial plan is $0 and has no Price — it is granted, never purchased.
  if (plan.trial_days > 0 && !plan.stripe_price_id) {
    return cors(json({ error: 'trial_not_billable', plan: planCode }, 400));
  }

  // Build one line item per product. Reading only line_items[0] is exactly the
  // bug that made add-ons invisible to the webhook, so the shape is symmetric:
  // whatever goes out here comes back through stripe_price_id on the way in.
  const lineItems: Array<{ price: string; quantity: number }> = [];

  if (!plan.stripe_price_id) {
    return cors(json({ error: 'product_missing_stripe_price', product: plan.code }, 400));
  }
  lineItems.push({ price: plan.stripe_price_id, quantity: 1 });

  for (const code of addons) {
    const addon = catalog.get(code);
    if (!addon || !addon.is_active || addon.kind !== 'addon') {
      return cors(json({ error: 'unknown_addon', addon: code }, 400));
    }
    if (!addon.stripe_price_id) {
      return cors(json({ error: 'product_missing_stripe_price', product: addon.code }, 400));
    }
    lineItems.push({ price: addon.stripe_price_id, quantity: 1 });
  }

  // Seats beyond what the plan includes are billed as a quantity on the seat
  // product ($99 each). branch_seats is the TOTAL the merchant wants, so the
  // billable quantity is the excess over plan.included_seats.
  const extraSeats = branchSeats - (plan.included_seats ?? 0);
  if (extraSeats > 0) {
    const seat = (catalogRows ?? []).find((p) => p.kind === 'seat' && p.is_active) as Product | undefined;
    if (!seat) return cors(json({ error: 'seat_product_missing' }, 400));
    if (!seat.stripe_price_id) {
      return cors(json({ error: 'product_missing_stripe_price', product: seat.code }, 400));
    }
    lineItems.push({
      price: seat.stripe_price_id,
      quantity: Math.ceil(extraSeats / Math.max(1, seat.seats_per_unit ?? 1)),
    });
  }

  // One Stripe Customer per restaurant, reused across plan changes. Canonical
  // home is restaurants.stripe_customer_id.
  const { data: rest } = await admin
    .from('restaurants')
    .select('id, name, stripe_customer_id')
    .eq('id', restaurantId)
    .maybeSingle();
  if (!rest) return cors(json({ error: 'restaurant_not_found' }, 404));

  let customerId = rest.stripe_customer_id as string | null;
  if (!customerId) {
    const custParams = new URLSearchParams({
      name: rest.name ?? 'Restaurant',
      'metadata[restaurant_id]': restaurantId,
    });
    if (user.email) custParams.set('email', user.email);
    const custRes = await stripe('customers', custParams, `cus_create_${restaurantId}`);
    if (!custRes.ok) return cors(json({ error: 'stripe_customer_failed', detail: custRes.data }, 502));
    customerId = custRes.data.id as string;
    await admin.from('restaurants').update({ stripe_customer_id: customerId }).eq('id', restaurantId);
  }

  const origin = req.headers.get('origin') ?? '';
  const successUrl = body.success_url || `${origin}/`;
  const cancelUrl = body.cancel_url || `${origin}/`;

  const params = new URLSearchParams({
    mode: 'subscription',
    customer: customerId,
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: restaurantId,
    allow_promotion_codes: 'true',
    // Only restaurant_id. plan_code is meaningless for a multi-line subscription
    // and stamping it is what let the old webhook collapse everything to one tier.
    'metadata[restaurant_id]': restaurantId,
    'subscription_data[metadata][restaurant_id]': restaurantId,
  });
  lineItems.forEach((li, i) => {
    params.set(`line_items[${i}][price]`, li.price);
    params.set(`line_items[${i}][quantity]`, String(li.quantity));
  });

  // Trial. A merchant converting on day 6 of 14 keeps their original end date:
  // trial_end is ABSOLUTE, so checking out does not restart the clock (and does
  // not silently grant 14 more free days). Stripe 400s if both trial_end and
  // trial_period_days are sent, so this is strictly one or the other.
  const { data: sub } = await admin
    .from('subscriptions')
    .select('status, trial_ends_at')
    .eq('restaurant_id', restaurantId)
    .maybeSingle();

  const trialEndsAt = sub?.trial_ends_at ? Date.parse(sub.trial_ends_at as string) : NaN;
  const nowMs = Date.now();
  if (sub?.status === 'trialing' && Number.isFinite(trialEndsAt) && trialEndsAt > nowMs) {
    // Stripe requires trial_end to be at least 48h out; below that, just convert
    // immediately rather than failing the checkout the merchant is standing in.
    const seconds = Math.floor(trialEndsAt / 1000);
    if (trialEndsAt - nowMs > 48 * 3600 * 1000) {
      params.set('subscription_data[trial_end]', String(seconds));
    }
  } else if (!sub && plan.trial_days > 0) {
    params.set('subscription_data[trial_period_days]', String(plan.trial_days));
  }

  // Idempotency key derived from the selection: a double-click or a retried
  // request returns the SAME session instead of opening a second subscription.
  // Changing the selection changes the key, so a genuine edit still gets a new one.
  const idem = `cs_${restaurantId}_${planCode}_${[...addons].sort().join('-') || 'none'}_${branchSeats}`;

  const sessRes = await stripe('checkout/sessions', params, idem);
  if (!sessRes.ok) return cors(json({ error: 'stripe_error', detail: sessRes.data }, 502));

  return cors(json({ url: sessRes.data.url, session_id: sessRes.data.id }));
});

async function stripe(path: string, params: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Stripe-Version': STRIPE_API_VERSION,
  };
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com/v1/${path}`, { method: 'POST', headers, body: params });
  const data = await res.json();
  return { ok: res.ok, data };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}
