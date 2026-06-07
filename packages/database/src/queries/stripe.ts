import type { FavornomsClient } from '../client-type';
import { getSupabaseEnv } from '../env';

export interface CreatePaymentIntentResult {
  client_secret: string;
  payment_intent_id: string;
  publishable_key: string | null;
}

/**
 * Calls the `stripe-create-payment-intent` edge function. The customer must be
 * signed in and own the order (RLS enforced server-side).
 */
export async function createStripePaymentIntent(
  supabase: FavornomsClient,
  orderId: string,
): Promise<CreatePaymentIntentResult> {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new Error('not_signed_in');

  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/stripe-create-payment-intent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ order_id: orderId }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`stripe_intent_failed:${res.status}:${text}`);
  }
  return (await res.json()) as CreatePaymentIntentResult;
}
