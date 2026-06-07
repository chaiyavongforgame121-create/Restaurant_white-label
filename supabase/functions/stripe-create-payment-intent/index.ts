// Stripe — Create a PaymentIntent for a placed order.
//
// Flow:
//   1. Customer signs in (Phone OTP).
//   2. Cart → checkout → place-order RPC creates the order (status: pending).
//   3. Client calls this function with { order_id } → returns { client_secret }.
//   4. Client confirms the PaymentIntent via Stripe.js / Elements.
//   5. Stripe webhook (stripe-webhook fn) updates payments + orders rows.
//
// Caller MUST be the customer (orders.customer_user_id == auth.uid).

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(new Response('method_not_allowed', { status: 405 }));

  if (!STRIPE_SECRET_KEY) {
    return cors(json({ error: 'stripe_not_configured' }, 503));
  }

  let body: { order_id?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.order_id) return cors(json({ error: 'order_id_required' }, 400));

  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));
  const userJwt = auth.slice(7);

  const userClient = createClient(SUPABASE_URL, userJwt, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${userJwt}` } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return cors(json({ error: 'invalid_token' }, 401));

  // RLS-checked: only the order's customer can read it.
  const { data: order, error: orderErr } = await userClient
    .from('orders')
    .select('id, total, status, customer_user_id, branch_id, order_number')
    .eq('id', body.order_id)
    .single();
  if (orderErr || !order) return cors(json({ error: 'order_not_found' }, 404));

  if (order.status !== 'pending' && order.status !== 'confirmed') {
    return cors(json({ error: 'order_not_payable', status: order.status }, 409));
  }

  // Amount in smallest currency unit (cents for USD).
  const amount = Math.round(Number(order.total) * 100);
  if (amount <= 50) return cors(json({ error: 'amount_too_small' }, 400));

  // Idempotency key keeps retries from creating duplicate intents.
  const idempotencyKey = `order_${order.id}`;

  const params = new URLSearchParams({
    amount: String(amount),
    currency: 'usd',
    'automatic_payment_methods[enabled]': 'true',
    'metadata[order_id]': order.id,
    'metadata[order_number]': order.order_number,
    'metadata[branch_id]': order.branch_id,
  });

  const stripeRes = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Idempotency-Key': idempotencyKey,
    },
    body: params,
  });
  const intent = await stripeRes.json();
  if (!stripeRes.ok) {
    return cors(json({ error: 'stripe_error', detail: intent }, 502));
  }

  // Record the pending payment via service-role client (bypasses RLS).
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });
  await admin.from('payments').upsert(
    {
      order_id: order.id,
      branch_id: order.branch_id,
      method: 'card',
      gateway: 'stripe',
      gateway_charge_id: intent.id,
      amount: Number(order.total),
      status: 'pending',
    },
    { onConflict: 'gateway_charge_id' },
  );

  return cors(
    json({
      client_secret: intent.client_secret,
      payment_intent_id: intent.id,
      publishable_key: Deno.env.get('STRIPE_PUBLISHABLE_KEY') ?? null,
    }),
  );
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}
