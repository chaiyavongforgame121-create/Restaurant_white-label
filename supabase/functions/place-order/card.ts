// place-order's card rules, with no I/O, so they can be unit-tested.
//
// Imports nothing on purpose: index.ts (Deno) imports it as './card.ts', and
// apps/web/src/lib/card-payment-edge.test.ts imports it from Node to pin every rule below. When
// deploying through the Management API / MCP rather than the CLI, pass this file with index.ts.

/**
 * The card service fee's ceiling, in percent. Mirror of SERVICE_FEE_MAX_PERCENT in
 * packages/shared/src/utils/pricing.ts: a Deno function cannot import the workspace package, so
 * card-payment-edge.test.ts fails if the two ever differ. 3, because the US card networks cap a
 * credit-card surcharge at 3%; a branch stored above it (the old ceiling was 25) is charged 3.
 */
export const SERVICE_FEE_MAX_PERCENT = 3;

/**
 * Stripe's smallest USD charge. A storefront card order below it could never be paid, so it is
 * refused before it is written rather than stranded as an order nobody can settle.
 */
export const CARD_MIN_CHARGE = 0.5;

/** A connected account id as Stripe issues them. */
const STRIPE_ACCOUNT_ID = /^acct_[A-Za-z0-9]+$/;

/** branches.settings.service_fee_percent as the percent charged: 0..SERVICE_FEE_MAX_PERCENT, and
 *  anything unreadable or negative is 0, so a malformed row can only undercharge. Mirrors
 *  computeServiceFee's clamp in packages/shared. */
export function serviceFeePercentOf(settings: Record<string, unknown>): number {
  return Math.max(0, Math.min(SERVICE_FEE_MAX_PERCENT, Number(settings.service_fee_percent ?? 0) || 0));
}

/**
 * A card paid on the storefront, through Stripe. A counter or POS card sale is taken on the shop's
 * own terminal and only recorded here, so it is not one: it needs no connected account, does not
 * wait for Stripe, and is not labelled as a Stripe payment.
 */
export function isStorefrontCard(paymentMethod: string, staffPlaced: boolean): boolean {
  return paymentMethod === 'card' && !staffPlaced;
}

/**
 * The branch's connected account id when it can take a card right now — private.branch_card_ready:
 * a branch_payment_accounts row with charges_enabled — else null. The row is read with the service
 * role; the storefront only ever sees the yes or no.
 */
export function readyStripeAccount(
  row: { stripe_account_id?: string | null; charges_enabled?: boolean | null } | null | undefined,
): string | null {
  if (!row || row.charges_enabled !== true) return null;
  const id = row.stripe_account_id;
  return typeof id === 'string' && STRIPE_ACCOUNT_ID.test(id) ? id : null;
}

/**
 * Whether a new order waits off the kitchen board for its money. A QR transfer waits for the slip
 * to be approved; a storefront card waits for Stripe. Nothing to pay waits for nothing: there is no
 * payment row (payments.amount must be above zero), so it could never be released.
 */
export function orderAwaitsPayment(paymentMethod: string, staffPlaced: boolean, total: number): boolean {
  return (paymentMethod === 'transfer' || isStorefrontCard(paymentMethod, staffPlaced)) && total > 0;
}

/** A storefront card order under Stripe's minimum, which could never be charged. */
export function cardTotalTooSmall(storefrontCard: boolean, total: number): boolean {
  return storefrontCard && total > 0 && total < CARD_MIN_CHARGE;
}

/**
 * The gateway columns of a new pending payment. Only a storefront card is a Stripe payment, and it
 * records the account it will be charged on, so the webhook and a refund are matched to the
 * account the money went to even if the branch later connects another.
 */
export function pendingPaymentGateway(
  storefrontCard: boolean,
  stripeAccount: string | null,
): { gateway: string | null; gateway_metadata: Record<string, unknown> } {
  return storefrontCard
    ? { gateway: 'stripe', gateway_metadata: { pending: true, stripe_account: stripeAccount } }
    : { gateway: null, gateway_metadata: { pending: true } };
}
