// Stripe — Billing Portal session (restaurant self-manages its card / cancels).
//
// Owner-only. Returns a short-lived Stripe-hosted portal URL for the restaurant's
// Stripe Customer, where they can update the payment method, view invoices, or
// cancel the subscription. Cancellation flows back via stripe-webhook.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return cors(new Response('ok'));
  if (req.method !== 'POST') return cors(json({ error: 'method_not_allowed' }, 405));
  if (!STRIPE_SECRET_KEY) return cors(json({ error: 'stripe_not_configured' }, 503));

  let body: { restaurant_id?: string; return_url?: string } = {};
  try {
    body = await req.json();
  } catch {
    return cors(json({ error: 'invalid_body' }, 400));
  }
  if (!body.restaurant_id) return cors(json({ error: 'restaurant_id_required' }, 400));

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return cors(json({ error: 'auth_required' }, 401));
  const userClient = createClient(SUPABASE_URL, authHeader.slice(7), {
    auth: { persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: userErr } = await userClient.auth.getUser();
  if (userErr || !user) return cors(json({ error: 'invalid_token' }, 401));

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  const { data: staff } = await admin
    .from('staff_members')
    .select('id')
    .eq('user_id', user.id)
    .eq('restaurant_id', body.restaurant_id)
    .eq('role', 'owner')
    .maybeSingle();
  if (!staff) return cors(json({ error: 'owner_only' }, 403));

  const { data: rest } = await admin
    .from('restaurants')
    .select('stripe_customer_id')
    .eq('id', body.restaurant_id)
    .single();
  if (!rest?.stripe_customer_id) return cors(json({ error: 'no_stripe_customer' }, 400));

  const origin = req.headers.get('origin') ?? '';
  const params = new URLSearchParams({
    customer: rest.stripe_customer_id,
    return_url: body.return_url || `${origin}/`,
  });

  const res = await fetch('https://api.stripe.com/v1/billing_portal/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
  });
  const data = await res.json();
  if (!res.ok) return cors(json({ error: 'stripe_error', detail: data }, 502));

  return cors(json({ url: data.url }));
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function cors(res: Response) {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Headers', 'authorization, x-client-info, apikey, content-type');
  res.headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  return res;
}
