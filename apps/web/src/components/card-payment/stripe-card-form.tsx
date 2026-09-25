'use client';

import * as React from 'react';
import { Elements, PaymentElement, useElements, useStripe } from '@stripe/react-stripe-js';
import type {
  PaymentIntentResult,
  StripeElementsOptions,
  StripeError,
} from '@stripe/stripe-js';
import { useTheme } from '@favornoms/ui';
import { CARD_PAYMENT_METHOD_TYPES, stripeLocale } from '@/lib/card-payment';
import { stripeFor } from '@/lib/stripe-loader';

/**
 * What the page holding the form can do with it. The submit handler lives outside <Elements>
 * (the checkout's own form), so the form hands these out instead of the page using Stripe's hooks.
 */
export interface CardFormApi {
  /** The connected account this form's Stripe instance acts as. A PaymentIntent created on any
   *  other account cannot be confirmed from here. */
  stripeAccount: string;
  /**
   * Check the entered details and, for a wallet, open its sheet. In the deferred flow this must be
   * the FIRST thing the submit handler awaits: Stripe requires it inside the diner's tap.
   */
  submit(): Promise<{ error?: StripeError }>;
  /**
   * Confirm the PaymentIntent. `clientSecret` is the new intent's in the deferred flow, null when
   * the form was built from one. Stays on the page for a card (3-D Secure opens over it); only a
   * redirect-based method leaves for its bank or wallet page and comes back to `returnUrl`.
   */
  confirm(clientSecret: string | null, returnUrl: string): Promise<PaymentIntentResult>;
}

export type CardFormState = 'loading' | 'ready' | 'failed';

interface Props {
  publishableKey: string;
  stripeAccount: string;
  locale: string;
  /** Deferred-intent mode (checkout, before the order exists): the amount in cents. */
  amountCents?: number;
  /** Intent mode (the order page's retry): the PaymentIntent's client secret. */
  clientSecret?: string;
  onApi: (api: CardFormApi | null) => void;
  onStateChange?: (state: CardFormState) => void;
}

/**
 * Stripe's Payment Element for one branch's connected account.
 *
 * The form is Stripe's own iframe: the card number never touches this app, and the payment it
 * confirms is a direct charge on the branch's account (the Stripe instance is created with that
 * account). Keyed by account and by client secret, because neither can change on a live
 * <Elements>; the amount can, and Stripe's wrapper passes a new one on.
 */
export function StripeCardForm({
  publishableKey,
  stripeAccount,
  locale,
  amountCents,
  clientSecret,
  onApi,
  onStateChange,
}: Props) {
  const { mode } = useTheme();
  const stripePromise = React.useMemo(
    () => stripeFor(publishableKey, stripeAccount),
    [publishableKey, stripeAccount],
  );

  // The script is fetched from js.stripe.com; a blocker or a dropped connection resolves to null,
  // which <Elements> would wait on forever. Say so instead.
  React.useEffect(() => {
    let cancelled = false;
    onStateChange?.('loading');
    void stripePromise.then((stripe) => {
      if (!cancelled && !stripe) onStateChange?.('failed');
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripePromise]);

  const appearance = React.useMemo(
    () => ({
      theme: mode === 'dark' ? ('night' as const) : ('stripe' as const),
      // The checkout's own inputs: 16px text (no zoom on iOS) and 0.875rem corners.
      variables: { borderRadius: '14px', fontSizeBase: '16px' },
    }),
    [mode],
  );

  const options = React.useMemo<StripeElementsOptions>(
    () =>
      clientSecret
        ? // The PaymentIntent already lists its payment methods (card only); the form follows it.
          { clientSecret, locale: stripeLocale(locale), appearance }
        : {
            mode: 'payment',
            // Stripe shows the amount in wallet sheets. A card order under 50 cents is refused by
            // place-order before any charge, so the floor here only keeps Elements valid.
            amount: Math.max(50, Math.round(amountCents ?? 0)),
            currency: 'usd',
            // Card only, the same list as the PaymentIntent the payment function creates. Without
            // it the branch's own Stripe settings decide, and a bank debit that takes days to
            // clear could be offered for an order that must be paid in minutes. The two lists
            // must match or Stripe refuses to confirm.
            paymentMethodTypes: [...CARD_PAYMENT_METHOD_TYPES],
            locale: stripeLocale(locale),
            appearance,
          },
    [clientSecret, amountCents, locale, appearance],
  );

  return (
    <Elements key={`${stripeAccount}:${clientSecret ?? 'deferred'}`} stripe={stripePromise} options={options}>
      <FormBridge
        stripeAccount={stripeAccount}
        deferred={!clientSecret}
        onApi={onApi}
        onStateChange={onStateChange}
      />
    </Elements>
  );
}

function FormBridge({
  stripeAccount,
  deferred,
  onApi,
  onStateChange,
}: {
  stripeAccount: string;
  deferred: boolean;
  onApi: (api: CardFormApi | null) => void;
  onStateChange?: (state: CardFormState) => void;
}) {
  const stripe = useStripe();
  const elements = useElements();

  React.useEffect(() => {
    if (!stripe || !elements) {
      onApi(null);
      return;
    }
    onApi({
      stripeAccount,
      submit: async () => {
        const result = await elements.submit();
        return result.error ? { error: result.error } : {};
      },
      confirm: (clientSecret, returnUrl) =>
        deferred && clientSecret
          ? stripe.confirmPayment({
              elements,
              clientSecret,
              confirmParams: { return_url: returnUrl },
              redirect: 'if_required',
            })
          : stripe.confirmPayment({
              elements,
              confirmParams: { return_url: returnUrl },
              redirect: 'if_required',
            }),
    });
    return () => onApi(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stripe, elements, stripeAccount, deferred]);

  return (
    <PaymentElement
      options={{ layout: 'tabs' }}
      onReady={() => onStateChange?.('ready')}
      onLoadError={(event) => {
        // The account cannot take this payment (restricted since the page loaded), or Stripe
        // refused the key. Logged for us; the page offers the other methods.
        console.error('stripe_payment_element_load_error', event.error?.type, event.error?.code);
        onStateChange?.('failed');
      }}
    />
  );
}
