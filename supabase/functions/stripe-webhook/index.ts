// Stripe webhook — verify signature, then reconcile BOTH:
//   (A) customer<->restaurant order payments  (payment_intent.*, charge.refunded)
//   (B) platform<->restaurant subscription billing
//       (customer.subscription.created/updated/deleted, invoice.paid/payment_failed)
//
// Configure in Stripe Dashboard → Developers → Webhooks
//   Endpoint URL: https://<project>.supabase.co/functions/v1/stripe-webhook
//   Events: payment_intent.succeeded, payment_intent.payment_failed, charge.refunded,
//           customer.subscription.created, customer.subscription.updated,
//           customer.subscription.deleted, invoice.paid, invoice.payment_failed
//
// This function must be deployed with verify_jwt = false (Stripe sends no JWT);
// authenticity is enforced by the HMAC signature check below.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');

// Stripe subscription.status → our subscription_status enum
// (trialing | active | past_due | cancelled | expired).
function mapSubStatus(s: string): string {
  switch (s) {
    case 'active':
    case 'paused':
      return 'active';
    case 'trialing':
      return 'trialing';
    case 'past_due':
    case 'incomplete':
      return 'past_due';
    case 'canceled':
      return 'cancelled';
    case 'unpaid':
    case 'incomplete_expired':
      return 'expired';
    default:
      return 'active';
  }
}

const TIERS = new Set(['starter', 'pro', 'enterprise']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!STRIPE_WEBHOOK_SECRET) return new Response('webhook_not_configured', { status: 503 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing_signature', { status: 400 });

  const raw = await req.text();
  const verified = await verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET);
  if (!verified) return new Response('bad_signature', { status: 400 });

  let event: { type: string; data: { object: Record<string, unknown> }; id: string };
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('invalid_json', { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  try {
    switch (event.type) {
      // ----- (A) order payments (customer pays restaurant) -----
      case 'payment_intent.succeeded': {
        const intent = event.data.object as { id: string; metadata?: { order_id?: string } };
        const orderId = intent.metadata?.order_id;
        if (orderId) {
          await admin.from('payments')
            .update({ status: 'completed', paid_at: new Date().toISOString() })
            .eq('gateway_charge_id', intent.id);
          await admin.from('orders').update({ status: 'confirmed' }).eq('id', orderId).eq('status', 'pending');
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as { id: string; last_payment_error?: { message?: string } };
        await admin.from('payments')
          .update({ status: 'failed', gateway_metadata: { last_payment_error: intent.last_payment_error?.message ?? 'unknown' } })
          .eq('gateway_charge_id', intent.id);
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as { id: string; payment_intent?: string; amount_refunded?: number };
        if (charge.payment_intent) {
          await admin.from('payments')
            .update({ status: 'refunded', gateway_metadata: { refund_charge_id: charge.id, amount_refunded: (charge.amount_refunded ?? 0) / 100 } })
            .eq('gateway_charge_id', charge.payment_intent);
        }
        break;
      }

      // ----- (B) subscription billing (platform charges restaurant) -----
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await syncSubscription(admin, event.data.object as StripeSub);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as StripeSub;
        await admin.from('subscriptions')
          .update({ status: 'cancelled', cancel_at_period_end: false, cancelled_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', sub.id);
        break;
      }
      case 'invoice.paid': {
        const inv = event.data.object as StripeInvoice;
        const subId = inv.subscription;
        const periodEnd = inv.lines?.data?.[0]?.period?.end;
        if (subId) {
          const patch: Record<string, unknown> = { status: 'active', updated_at: new Date().toISOString() };
          if (periodEnd) {
            patch.current_period_end = new Date(periodEnd * 1000).toISOString();
            patch.next_billing_at = new Date(periodEnd * 1000).toISOString();
          }
          await admin.from('subscriptions').update(patch).eq('stripe_subscription_id', subId);
        }
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object as StripeInvoice;
        if (inv.subscription) {
          await admin.from('subscriptions')
            .update({ status: 'past_due', updated_at: new Date().toISOString() })
            .eq('stripe_subscription_id', inv.subscription);
        }
        break;
      }

      default:
        // Unhandled → 200 so Stripe doesn't retry.
        break;
    }
  } catch (err) {
    console.error('webhook error', event?.type, err);
    return new Response('internal_error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});

interface StripeSub {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  metadata?: { restaurant_id?: string; plan_code?: string };
  items?: { data?: Array<{ price?: { id?: string } }> };
}
interface StripeInvoice {
  id: string;
  subscription?: string;
  lines?: { data?: Array<{ period?: { end?: number } }> };
}

// Upsert the public.subscriptions row for a Stripe subscription. Keyed by
// stripe_subscription_id (unique). Resolves plan/tier/price from subscription
// metadata first, then falls back to matching the Stripe price → subscription_plans.
async function syncSubscription(admin: SupabaseClient, sub: StripeSub) {
  const priceId = sub.items?.data?.[0]?.price?.id ?? null;

  let planCode = sub.metadata?.plan_code ?? null;
  let restaurantId = sub.metadata?.restaurant_id ?? null;
  let unitPrice: number | null = null;

  // Prefer resolving the plan from the price id (source of truth for amount).
  if (priceId) {
    const { data: plan } = await admin
      .from('subscription_plans')
      .select('code, monthly_price')
      .eq('stripe_price_id', priceId)
      .maybeSingle();
    if (plan) {
      planCode = planCode ?? plan.code;
      unitPrice = Number(plan.monthly_price);
    }
  }

  // Fall back to the restaurant that owns this Stripe customer.
  if (!restaurantId && sub.customer) {
    const { data: rest } = await admin
      .from('restaurants')
      .select('id')
      .eq('stripe_customer_id', sub.customer)
      .maybeSingle();
    restaurantId = rest?.id ?? null;
  }
  if (!restaurantId) {
    console.error('subscription_sync: cannot resolve restaurant', sub.id, sub.customer);
    return;
  }

  const tier = planCode && TIERS.has(planCode) ? planCode : 'starter';
  const now = new Date().toISOString();
  const row: Record<string, unknown> = {
    restaurant_id: restaurantId,
    plan_code: planCode,
    tier,
    status: mapSubStatus(sub.status),
    billing_cycle: 'monthly',
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : now,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : now,
    next_billing_at: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    updated_at: now,
  };
  if (unitPrice != null) row.unit_price = unitPrice;

  await admin.from('subscriptions').upsert(row, { onConflict: 'stripe_subscription_id' });
}

// HMAC-SHA256 verification per Stripe spec.
async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((p) => {
      const [k, v] = p.split('=');
      return [k, v ?? ''];
    }),
  );
  const t = parts['t'];
  const v1 = parts['v1'];
  if (!t || !v1) return false;
  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(sigBytes)).map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, v1);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
