// Stripe — Create a subscription Checkout Session (PLATFORM charges the RESTAURANT).
//
// B2B billing: the platform's own Stripe account collects a monthly subscription
// from each restaurant. This is SEPARATE from customer<->restaurant order payments
// (those restaurants collect themselves). Reuses STRIPE_SECRET_KEY = platform account.
//
// Flow:
//   1. Owner opens /b/[branchId]/settings/plan and picks a PAID plan.
//   2. Client calls this fn (functions.invoke attaches the owner's JWT).
//   3. We verify the caller is the restaurant OWNER, resolve/create a Stripe
//      Customer for the restaurant, and open a Checkout Session in subscription mode.
//   4. Client redirects to session.url. Stripe hosts the card entry.
//   5. stripe-webhook (customer.subscription.created / invoice.paid) writes the
//      public.subscriptions row and keeps it in sync.
//
// Free plan is NOT handled here (no Stripe price) — downgrades go through the
// upgrade_plan RPC / billing portal cancel.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405));
  if (!STRIPE_SECRET_KEY) return cors(json({ error: 'stripe_not_configured' }, 503));

  let body: { restaurant_id?: string; plan_code?: string; success_url?: string; cancel_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.restaurant_id || !body.plan_code) return cors(json({ error: 'restaurant_id_and_plan_code_required' }, 400));

  // Authenticate the caller (owner JWT forwarded by functions.invoke).
  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));
  const userClient = createClient(SUPABASE_URL, authHeader.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return cors(json({ error: 'invalid_token' }, 401));

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  // Owner-only, on this restaurant.
  const { data: staff } = await admin
    .from('staff_members')
    .select('id')
    .eq('user_id', user.id)
    .eq('restaurant_id', body.restaurant_id)
    .eq('role', 'owner')
    .maybeSingle();
  if (!staff) return cors(json({ error: 'owner_only' }, 403));

  // Resolve the plan → Stripe price. Free / price-less plans are not billable here.
  const { data: plan } = await admin
    .from('subscription_plans')
    .select('code, name, stripe_price_id, is_active')
    .eq('code', body.plan_code)
    .maybeSingle();
  if (!plan || !plan.is_active) return cors(json({ error: 'unknown_plan' }, 404));
  if (plan.code === 'free') return cors(json({ error: 'free_plan_not_billable' }, 400));
  if (!plan.stripe_price_id) return cors(json({ error: 'plan_missing_stripe_price', plan: plan.code }, 400));

  // One Stripe Customer per restaurant, reused across plan changes. Canonical home
  // is restaurants.stripe_customer_id.
  const { data: rest } = await admin
    .from('restaurants')
    .select('id, name, stripe_customer_id')
    .eq('id', body.restaurant_id)
    .single();
  if (!rest) return cors(json({ error: 'restaurant_not_found' }, 404));

  let customerId = rest.stripe_customer_id as string | null;
  if (!customerId) {
    const custParams = new URLSearchParams({
      name: rest.name ?? 'Restaurant',
      'metadata[restaurant_id]': body.restaurant_id,
    });
    if (user.email) custParams.set('email', user.email);
    const custRes = await stripe('customers', custParams, `cus_create_${body.restaurant_id}`);
    if (!custRes.ok) return cors(json({ error: 'stripe_customer_failed', detail: custRes.data }, 502));
    customerId = custRes.data.id as string;
    await admin.from('restaurants').update({ stripe_customer_id: customerId }).eq('id', body.restaurant_id);
  }

  const origin = req.headers.get('origin') ?? '';
  const successUrl = body.success_url || `${origin}/`;
  const cancelUrl = body.cancel_url || `${origin}/`;

  const params = new URLSearchParams({
    mode: 'subscription',
    customer: customerId,
    'line_items[0][price]': plan.stripe_price_id,
    'line_items[0][quantity]': '1',
    success_url: successUrl,
    cancel_url: cancelUrl,
    client_reference_id: body.restaurant_id,
    allow_promotion_codes: 'true',
    // Stamp identity on BOTH the session and the resulting subscription so the
    // webhook can map events → restaurant/plan without a DB round-trip.
    'metadata[restaurant_id]': body.restaurant_id,
    'metadata[plan_code]': plan.code,
    'subscription_data[metadata][restaurant_id]': body.restaurant_id,
    'subscription_data[metadata][plan_code]': plan.code,
  });

  const sessRes = await stripe('checkout/sessions', params);
  if (!sessRes.ok) return cors(json({ error: 'stripe_error', detail: sessRes.data }, 502));

  return cors(json({ url: sessRes.data.url, session_id: sessRes.data.id }));
});

async function stripe(path: string, params: URLSearchParams, idempotencyKey?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
    'Content-Type': 'application/x-www-form-urlencoded',
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
