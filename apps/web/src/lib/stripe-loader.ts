// Stripe.js for one branch's connected account, loaded once per account.
//
// `@stripe/stripe-js/pure` rather than the package root: the root injects Stripe's script into
// every page that merely imports it, and the storefront only needs it where a card form is shown.
// The script is always fetched from js.stripe.com by the loader (PCI requires that it is never
// bundled or self-hosted).
//
// One Stripe instance per publishable key AND account. A direct charge is confirmed as the
// connected account, so the instance must be created with `stripeAccount` — the same account the
// server created the PaymentIntent on — and Stripe's React wrapper refuses a different instance
// once an <Elements> has one, so the promise is kept rather than recreated on every render.

import { loadStripe } from '@stripe/stripe-js/pure';
import type { Stripe } from '@stripe/stripe-js';

const instances = new Map<string, Promise<Stripe | null>>();

export function stripeFor(publishableKey: string, stripeAccount: string): Promise<Stripe | null> {
  const key = `${publishableKey}:${stripeAccount}`;
  let instance = instances.get(key);
  if (!instance) {
    instance = loadStripe(publishableKey, { stripeAccount }).catch(() => {
      // A blocked or failed script load is not permanent (an ad blocker switched off, a network
      // that came back): forget it so the next attempt loads again. Resolved as null, which
      // <Elements> simply waits on and the card form reads as "could not load", rather than a
      // rejection nobody handles.
      instances.delete(key);
      return null;
    });
    instances.set(key, instance);
  }
  return instance;
}
