// Why an order was cancelled, as the diner reads it on the order page.
//
// orders.cancellation_reason is free text, stored in English. Most of it is written by a machine
// or picked from a fixed list: the card expiry job, place-order, the refused transfer slip, the
// diner's own Cancel button, the kitchen's Reject, the back office's Cancel and the Live
// deliveries presets. Printed as stored, a diner reading in Thai, Spanish or Vietnamese got those
// in English, and the expiry job's "within 30 minutes" contradicted the page's own "pay within 28
// minutes" a moment earlier. Those known sentences are therefore said in the diner's language
// (tracking.closed.reasons.*); anything else is what a person typed, and is shown exactly as
// written. cancellation-reason.test.ts checks that every sentence below is still written, word
// for word, by the code that writes it, so a reworded writer cannot silently fall back to English.

export type CancellationReasonKey =
  | 'cardExpired'
  | 'cardSetupFailed'
  | 'slipRejected'
  | 'customerCancelled'
  | 'kitchenRejected'
  | 'restaurantCancelled'
  | 'kitchenCannotMake'
  | 'customerAsked'
  | 'noRider'
  | 'duplicate';

/** The stored English sentence, as its writer spells it, and what the diner is told instead. */
export const KNOWN_CANCELLATION_REASONS: ReadonlyArray<{ stored: string; key: CancellationReasonKey }> = [
  // private.expire_unpaid_card_orders (20260925100000_stripe_connect_payments.sql).
  { stored: 'The card payment was not completed within 30 minutes.', key: 'cardExpired' },
  // place-order, when the card payment row could not be written.
  { stored: 'The card payment could not be set up.', key: 'cardSetupFailed' },
  // decide_payment_proof, when the restaurant refused a slip without typing a note.
  { stored: 'Payment slip was not accepted.', key: 'slipRejected' },
  // The diner's own Cancel on this page (order-actions.tsx).
  { stored: 'Cancelled by the customer before payment was confirmed.', key: 'customerCancelled' },
  // The kitchen board's Reject.
  { stored: 'Rejected by kitchen', key: 'kitchenRejected' },
  // The back office's Orders page.
  { stored: 'Admin canceled', key: 'restaurantCancelled' },
  // Live deliveries' preset reasons.
  { stored: 'Kitchen cannot make it', key: 'kitchenCannotMake' },
  { stored: 'Customer asked to cancel', key: 'customerAsked' },
  { stored: 'No rider available', key: 'noRider' },
  { stored: 'Duplicate order', key: 'duplicate' },
];

const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

const BY_STORED = new Map(KNOWN_CANCELLATION_REASONS.map((r) => [normalize(r.stored), r.key]));

/** The key under tracking.closed.reasons for a known stored reason, or null for free text. */
export function cancellationReasonKey(reason: string | null | undefined): CancellationReasonKey | null {
  if (!reason) return null;
  return BY_STORED.get(normalize(reason)) ?? null;
}
