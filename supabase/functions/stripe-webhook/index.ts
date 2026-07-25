// Stripe webhook — verify signature, then reconcile BOTH:
//   (A) customer<->restaurant order payments  (payment_intent.*, charge.*)
//   (B) platform<->restaurant subscription billing (checkout, subscription.*, invoice.*)
//
// Configure in Stripe Dashboard → Developers → Webhooks
//   Endpoint URL: https://<project>.supabase.co/functions/v1/stripe-webhook
//   Events (13 — see docs/CONFIG-CHECKLIST.md):
//     checkout.session.completed            customer.subscription.created
//     customer.subscription.updated         customer.subscription.deleted
//     customer.subscription.trial_will_end
//     invoice.paid                          invoice.payment_failed
//     invoice.payment_action_required       invoice.marked_uncollectible
//     payment_intent.succeeded              payment_intent.payment_failed
//     charge.refunded                       charge.dispute.created
//
// This function must be deployed with verify_jwt = false (Stripe sends no JWT);
// authenticity is enforced by the HMAC signature check below.
//
// Division of labour: this function does transport only — verify, de-duplicate,
// normalise the payload, and hand it to SQL. All entitlement arithmetic lives in
// public.stripe_sync_subscription(), so the manual-activation path and the Stripe
// path cannot drift apart.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient, SupabaseClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');
const STRIPE_SECRET_KEY = Deno.env.get('STRIPE_SECRET_KEY');

/** Pinned everywhere we talk to Stripe. A mismatch changes payload shapes. */
const STRIPE_API_VERSION = '2025-08-27.basil';

/** Reject signatures older than this. Without it a captured body replays forever. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

interface StripeEvent {
  id: string;
  type: string;
  api_version?: string;
  data: { object: Record<string, unknown> };
}

interface StripeSub {
  id: string;
  customer: string;
  status: string;
  cancel_at_period_end?: boolean;
  current_period_start?: number;
  current_period_end?: number;
  trial_end?: number;
  metadata?: { restaurant_id?: string };
  items?: { data?: Array<{ price?: { id?: string }; quantity?: number }> };
}

interface StripeInvoice {
  id: string;
  customer?: string;
  subscription?: string;
  /** 2025-era API versions moved the subscription pointer under `parent`. */
  parent?: { subscription_details?: { subscription?: string } };
  lines?: { data?: Array<{ period?: { end?: number } }> };
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('method_not_allowed', { status: 405 });
  if (!STRIPE_WEBHOOK_SECRET) return new Response('webhook_not_configured', { status: 503 });

  const sig = req.headers.get('stripe-signature');
  if (!sig) return new Response('missing_signature', { status: 400 });

  const raw = await req.text();
  const verified = await verifyStripeSignature(raw, sig, STRIPE_WEBHOOK_SECRET);
  if (!verified) return new Response('bad_signature', { status: 400 });

  let event: StripeEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return new Response('invalid_json', { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

  if (event.api_version && event.api_version !== STRIPE_API_VERSION) {
    // Not fatal — but every field path below was written against the pinned
    // version, so this is the first thing to check when a handler goes quiet.
    console.warn(
      `stripe api_version mismatch: event=${event.api_version} pinned=${STRIPE_API_VERSION} (${event.type})`,
    );
    await logEvent(admin, 'stripe.api_version_mismatch', 'warn', 'event api_version differs from pinned', null, {
      event_id: event.id,
      event_type: event.type,
      event_api_version: event.api_version,
      pinned: STRIPE_API_VERSION,
    });
  }

  // Idempotency. Stripe retries on any non-2xx and may deliver twice even on
  // success, so every handler below would otherwise be able to run more than
  // once. `stripe_event_seen` inserts-or-ignores and returns false on a repeat.
  const { data: fresh, error: seenErr } = await admin.rpc('stripe_event_seen', {
    p_event_id: event.id,
    p_type: event.type,
  });
  if (seenErr) {
    // Fail loud: a 500 makes Stripe retry, which is the safe direction. Silently
    // continuing would process the event with no replay protection at all.
    console.error('stripe_event_seen failed', seenErr);
    return new Response('idempotency_check_failed', { status: 500 });
  }
  if (fresh === false) return new Response('duplicate', { status: 200 });

  try {
    switch (event.type) {
      // ----- (A) order payments (customer pays restaurant) -----
      case 'payment_intent.succeeded': {
        const intent = event.data.object as unknown as { id: string; metadata?: { order_id?: string } };
        const orderId = intent.metadata?.order_id;
        if (orderId) {
          await admin
            .from('payments')
            .update({ status: 'completed', paid_at: new Date().toISOString() })
            .eq('gateway_charge_id', intent.id);
          await admin.from('orders').update({ status: 'confirmed' }).eq('id', orderId).eq('status', 'pending');
        }
        break;
      }
      case 'payment_intent.payment_failed': {
        const intent = event.data.object as unknown as {
          id: string;
          last_payment_error?: { message?: string };
        };
        await admin
          .from('payments')
          .update({
            status: 'failed',
            gateway_metadata: { last_payment_error: intent.last_payment_error?.message ?? 'unknown' },
          })
          .eq('gateway_charge_id', intent.id);
        break;
      }
      case 'charge.refunded': {
        const charge = event.data.object as unknown as {
          id: string;
          payment_intent?: string;
          amount_refunded?: number;
        };
        if (charge.payment_intent) {
          await admin
            .from('payments')
            .update({
              status: 'refunded',
              gateway_metadata: {
                refund_charge_id: charge.id,
                amount_refunded: (charge.amount_refunded ?? 0) / 100,
              },
            })
            .eq('gateway_charge_id', charge.payment_intent);
        }
        break;
      }
      case 'charge.dispute.created': {
        // A dispute is not a refund — the money is held, not returned, and the
        // restaurant needs to know a human has to respond within Stripe's window.
        const dispute = event.data.object as unknown as {
          id: string;
          charge?: string;
          payment_intent?: string;
          amount?: number;
          reason?: string;
        };
        const ref = dispute.payment_intent ?? dispute.charge;
        if (ref) {
          // payment_status has no 'disputed' member and the money has not moved
          // yet, so the status stays as-is; the dispute is recorded alongside it.
          // Read-modify-write because a bare .update() on a jsonb column replaces
          // it wholesale, which would erase the original gateway response.
          const { data: existing } = await admin
            .from('payments')
            .select('id, gateway_metadata')
            .eq('gateway_charge_id', ref)
            .maybeSingle();
          if (existing) {
            await admin
              .from('payments')
              .update({
                gateway_metadata: {
                  ...((existing.gateway_metadata as Record<string, unknown> | null) ?? {}),
                  dispute_id: dispute.id,
                  dispute_reason: dispute.reason ?? 'unknown',
                  dispute_amount: (dispute.amount ?? 0) / 100,
                  disputed_at: new Date().toISOString(),
                },
              })
              .eq('id', existing.id);
          }
        }
        await logEvent(admin, 'stripe.dispute_created', 'warn', 'a charge was disputed', null, {
          dispute_id: dispute.id,
          charge: dispute.charge,
          payment_intent: dispute.payment_intent,
          reason: dispute.reason,
        });
        break;
      }

      // ----- (B) subscription billing (platform charges restaurant) -----
      case 'checkout.session.completed': {
        // The subscription.created event carries the same information and
        // usually lands first, but ordering is not guaranteed. Syncing here too
        // means the merchant is entitled the moment they finish paying rather
        // than whenever the second event happens to arrive.
        const session = event.data.object as unknown as {
          id: string;
          mode?: string;
          customer?: string;
          subscription?: string;
          metadata?: { restaurant_id?: string };
        };
        if (session.mode !== 'subscription' || !session.subscription) break;
        const sub = await fetchSubscription(session.subscription);
        if (!sub) {
          await logEvent(
            admin,
            'stripe.session_sub_fetch_failed',
            'error',
            'checkout completed but the subscription could not be read back',
            session.metadata?.restaurant_id ?? null,
            { session_id: session.id, subscription: session.subscription },
          );
          break;
        }
        await syncSubscription(admin, sub, session.metadata?.restaurant_id ?? null);
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        await syncSubscription(admin, event.data.object as unknown as StripeSub, null);
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = event.data.object as unknown as StripeSub;
        // Route through the same SQL as every other change so entitlements and
        // branches.entitled_through are recomputed, rather than patching the
        // status column and leaving the mirror stale.
        await syncSubscription(admin, { ...sub, status: 'canceled' }, null);
        break;
      }
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object as unknown as StripeSub;
        const restaurantId = await resolveRestaurant(admin, sub.customer, sub.id);
        await logEvent(
          admin,
          'stripe.trial_will_end',
          'info',
          'trial ends in 3 days',
          restaurantId,
          { subscription: sub.id, trial_end: sub.trial_end ?? null },
        );
        break;
      }
      case 'invoice.paid': {
        const inv = event.data.object as unknown as StripeInvoice;
        const subId = invoiceSubscription(inv);
        if (!subId) break;
        const periodEnd = inv.lines?.data?.[0]?.period?.end;
        const patch: Record<string, unknown> = { status: 'active', updated_at: new Date().toISOString() };
        if (periodEnd) {
          patch.current_period_end = new Date(periodEnd * 1000).toISOString();
          patch.next_billing_at = new Date(periodEnd * 1000).toISOString();
        }
        await admin.from('subscriptions').update(patch).eq('stripe_subscription_id', subId);
        await assertResolvable(admin, inv, subId);
        break;
      }
      case 'invoice.payment_failed':
      case 'invoice.payment_action_required': {
        const inv = event.data.object as unknown as StripeInvoice;
        const subId = invoiceSubscription(inv);
        if (!subId) break;
        await admin
          .from('subscriptions')
          .update({ status: 'past_due', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        await assertResolvable(admin, inv, subId);
        break;
      }
      case 'invoice.marked_uncollectible': {
        // Stripe has given up on this invoice. Treat it as the end of the paid
        // period rather than a retryable failure.
        const inv = event.data.object as unknown as StripeInvoice;
        const subId = invoiceSubscription(inv);
        if (!subId) break;
        await admin
          .from('subscriptions')
          .update({ status: 'expired', updated_at: new Date().toISOString() })
          .eq('stripe_subscription_id', subId);
        await assertResolvable(admin, inv, subId);
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

/**
 * `invoice.subscription` was a top-level string until 2025, when it moved under
 * `parent.subscription_details`. Reading only the old path is why renewals
 * silently no-op on a modern account; read both.
 */
function invoiceSubscription(inv: StripeInvoice): string | null {
  return inv.subscription ?? inv.parent?.subscription_details?.subscription ?? null;
}

/**
 * Hand a Stripe subscription to SQL. Every line item is mapped — a subscription
 * here is Base + any of Delivery / AI Suite / extra branch seats, so reading
 * only `items.data[0]` would silently drop whatever the merchant bought second.
 */
async function syncSubscription(
  admin: SupabaseClient,
  sub: StripeSub,
  restaurantIdHint: string | null,
) {
  const items = (sub.items?.data ?? [])
    .map((i) => ({ price_id: i.price?.id ?? null, quantity: Math.max(1, i.quantity ?? 1) }))
    .filter((i): i is { price_id: string; quantity: number } => Boolean(i.price_id));

  const { data, error } = await admin.rpc('stripe_sync_subscription', {
    p_restaurant_id: restaurantIdHint ?? sub.metadata?.restaurant_id ?? null,
    p_stripe_customer_id: sub.customer ?? null,
    p_stripe_subscription_id: sub.id,
    p_status: sub.status,
    p_items: items,
    p_period_start: sub.current_period_start
      ? new Date(sub.current_period_start * 1000).toISOString()
      : null,
    p_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    p_trial_end: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    p_cancel_at_period_end: sub.cancel_at_period_end ?? false,
  });

  if (error) {
    console.error('stripe_sync_subscription failed', sub.id, error);
    await logEvent(admin, 'stripe.sync_failed', 'error', error.message, null, {
      subscription: sub.id,
      customer: sub.customer,
    });
    // Rethrow so the outer catch returns 500 and Stripe retries. A dropped sync
    // means the merchant paid and stayed suspended.
    throw new Error(`stripe_sync_subscription: ${error.message}`);
  }

  // The RPC reports unresolved customers / unknown prices into billing_events
  // itself; surface it in the function log too so it is visible without a query.
  const result = data as { ok?: boolean; error?: string } | null;
  if (result?.ok !== true) {
    console.error('stripe_sync_subscription rejected', sub.id, result?.error);
  }
}

/**
 * The entitlement recompute is NOT done here — the AFTER UPDATE trigger on
 * `subscriptions` already calls private.billing_compute(), so the UPDATE above
 * refreshes billing_entitlements and branches.entitled_through by itself.
 *
 * What this does check is that the invoice actually matched a restaurant. The
 * UPDATE is filtered by stripe_subscription_id, so an unknown subscription is
 * not an error — it silently touches zero rows, and a renewal that quietly
 * changed nothing is exactly the failure that would go unnoticed until the
 * merchant's storefront went dark.
 */
async function assertResolvable(admin: SupabaseClient, inv: StripeInvoice, subId: string) {
  const restaurantId = await resolveRestaurant(admin, inv.customer, subId);
  if (restaurantId) return;
  await logEvent(
    admin,
    'stripe.unresolved_customer',
    'error',
    'invoice references a subscription with no matching restaurant; nothing was updated',
    null,
    { invoice: inv.id, customer: inv.customer, subscription: subId },
  );
}

async function resolveRestaurant(
  admin: SupabaseClient,
  customerId: string | null | undefined,
  subscriptionId: string | null | undefined,
): Promise<string | null> {
  const { data, error } = await admin.rpc('stripe_resolve_restaurant', {
    p_customer_id: customerId ?? null,
    p_subscription_id: subscriptionId ?? null,
  });
  if (error) {
    console.error('stripe_resolve_restaurant failed', error);
    return null;
  }
  return (data as string | null) ?? null;
}

async function logEvent(
  admin: SupabaseClient,
  type: string,
  level: 'info' | 'warn' | 'error',
  note: string,
  restaurantId: string | null,
  payload: Record<string, unknown>,
) {
  const { error } = await admin.rpc('billing_log_event', {
    p_type: type,
    p_level: level,
    p_note: note,
    p_restaurant_id: restaurantId,
    p_payload: payload,
  });
  if (error) console.error('billing_log_event failed', type, error);
}

/** Read a subscription back from Stripe (checkout.session carries only its id). */
async function fetchSubscription(id: string): Promise<StripeSub | null> {
  if (!STRIPE_SECRET_KEY) return null;
  const res = await fetch(`https://api.stripe.com/v1/subscriptions/${id}`, {
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Stripe-Version': STRIPE_API_VERSION,
    },
  });
  if (!res.ok) {
    console.error('fetchSubscription failed', id, res.status, await res.text());
    return null;
  }
  return (await res.json()) as StripeSub;
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

  // Replay window. The signature itself never expires, so without this check a
  // body captured once can be re-POSTed indefinitely and still verify.
  const ts = Number(t);
  if (!Number.isFinite(ts)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - ts) > SIGNATURE_TOLERANCE_SECONDS) return false;

  const signedPayload = `${t}.${payload}`;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sigBytes = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(signedPayload));
  const hex = Array.from(new Uint8Array(sigBytes))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return timingSafeEqual(hex, v1);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return result === 0;
}
