// Stripe webhook — verify signature, then reconcile payments + orders.
//
// Configure in Stripe Dashboard → Developers → Webhooks
//   Endpoint URL: https://<project>.supabase.co/functions/v1/stripe-webhook
//   Events: payment_intent.succeeded, payment_intent.payment_failed, charge.refunded
//
// We expect the corresponding payments row to exist (created by
// stripe-create-payment-intent). We update it + the parent order.

import 'jsr:@supabase/functions-js/edge-runtime.d.ts';
import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const STRIPE_WEBHOOK_SECRET = Deno.env.get('STRIPE_WEBHOOK_SECRET');

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

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  try {
    switch (event.type) {
      case 'payment_intent.succeeded': {
        const intent = event.data.object as { id: string; metadata?: { order_id?: string }; amount_received?: number };
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
        const intent = event.data.object as { id: string; last_payment_error?: { message?: string } };
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
        const charge = event.data.object as {
          id: string;
          payment_intent?: string;
          amount_refunded?: number;
          metadata?: { order_id?: string };
        };
        const pid = charge.payment_intent;
        if (pid) {
          await admin
            .from('payments')
            .update({ status: 'refunded', gateway_metadata: { refund_charge_id: charge.id, amount_refunded: (charge.amount_refunded ?? 0) / 100 } })
            .eq('gateway_charge_id', pid);
        }
        break;
      }
      default:
        // Ignore unhandled events but return 200 so Stripe doesn't retry.
        break;
    }
  } catch (err) {
    console.error('webhook error', err);
    return new Response('internal_error', { status: 500 });
  }

  return new Response('ok', { status: 200 });
});

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
