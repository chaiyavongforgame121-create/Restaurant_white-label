import type { CartPart } from '@/store/cart';

// place-order's error codes, rendered for a customer: each code maps to the message key that
// says it (the sentences are errors.order.* in messages/<locale>/errors.json). A message that
// carries none of these codes shows errors.generic, never the raw server text.
//
// The billing codes (402 billing_inactive / 403 feature_not_entitled) are
// deliberately phrased as restaurant availability: the customer is not the
// party who owes anything, and telling them the restaurant hasn't paid is a
// reputational hit we have no right to inflict. Order is significant —
// `dropoff_other_required` contains `dropoff_required` as a substring.
export const ORDER_ERRORS: Array<[string, string]> = [
  ['billing_inactive', 'errors.order.billingInactive'],
  // Both of these mean "this BRANCH does not deliver", not "the restaurant stopped offering
  // delivery": delivery is switched per branch (docs/PACKAGING-2026-10-24.md §3), so a diner at
  // Hamburger can be refused while Food Thai Thai is still delivering. The sentence was
  // "This restaurant is not offering delivery right now", which is wrong twice over — wrong
  // scope, and "right now" promises a temporary state that nothing will change. It now opens
  // with checkout.orderType.deliveryNotOffered word for word and says what
  // orderType.deliveryNotOffered says; the only temporary delivery sentence on the storefront
  // is orderType.deliveryClosedNow, and place-order never produces it. Reached by a checkout
  // page rendered before the switch was thrown, and by the quote race place-order refuses
  // after its up-front gate (the quote_delivery `delivery_not_entitled` branch).
  ['feature_not_entitled:delivery', 'errors.order.deliveryNotOffered'],
  ['delivery_not_entitled', 'errors.order.deliveryNotOffered'],
  ['feature_not_entitled:card_payment', 'errors.order.cardNotAvailable'],
  // The branch has no Stripe account that can take charges right now (never connected, still
  // under review, or restricted since this page loaded). The checkout only offers card where it
  // can be paid, so this is the race; the diner is told to pick another method, not to retry.
  ['card_not_configured', 'errors.order.cardNotConfigured'],
  // Under Stripe's 50-cent minimum: a card cannot be charged that little.
  ['card_amount_too_small', 'errors.order.cardAmountTooSmall'],
  // The order was called off because its card payment could not be set up; nothing was charged.
  ['payment_insert_failed', 'errors.order.cardSetupFailed'],
  // Must precede `branch_closed` — it contains it as a substring, and the
  // generic "currently closed" line is wrong here: the restaurant may well be
  // open now, it's the time they picked that isn't served.
  ['branch_closed_at_scheduled_time', 'errors.order.closedAtScheduledTime'],
  // Distinct from being closed: the restaurant may well be open then, it just does not take
  // advance orders at that hour. Saying "closed" would send the diner to look at opening
  // hours that already agree with them.
  ['outside_scheduling_window', 'errors.order.outsideSchedulingWindow'],
  // Channel-neutral on purpose: a seated dine-in round reaches this too.
  ['branch_closed', 'errors.order.branchClosed'],
  // No fixed numbers here any more: how soon and how far ahead are per-branch settings, so
  // quoting "10 minutes" and "14 days" would state someone else's policy as fact. The
  // picker only offers times inside the real one, so reaching these is already unusual.
  ['scheduled_too_soon', 'errors.order.scheduledTooSoon'],
  ['scheduled_too_far', 'errors.order.scheduledTooFar'],
  ['scheduling_disabled', 'errors.order.schedulingDisabled'],
  ['invalid_scheduled_for', 'errors.order.invalidScheduledFor'],
  ['delivery_out_of_range', 'errors.order.deliveryOutOfRange'],
  ['payment_method_not_accepted', 'errors.order.paymentMethodNotAccepted'],
  ['transfer_not_configured', 'errors.order.transferNotConfigured'],
  ['delivery_not_available_at_that_time', 'errors.order.deliveryNotAvailableAtThatTime'],
  ['dropoff_other_required', 'errors.order.dropoffOtherRequired'],
  ['dropoff_required', 'errors.order.dropoffRequired'],
  // Dine-in is a sitting now, so the ways it can be refused are about the table's session
  // rather than about a number the diner typed. Every one of these is a server decision —
  // the phone cannot know a bill was settled while the diner was still choosing dessert.
  ['table_session_closed', 'errors.order.tableSessionClosed'],
  ['table_session_changed', 'errors.order.tableSessionChanged'],
  ['table_not_seated', 'errors.order.tableNotSeated'],
  ['not_at_this_table', 'errors.order.notAtThisTable'],
  ['table_not_in_branch', 'errors.order.tableNotInBranch'],
  ['sign_in_required', 'errors.order.signInRequired'],
  // There is no table field to send them back to any more — the order reached the server
  // without a table because the pin was gone by the time they pressed the button.
  ['table_required', 'errors.order.tableRequired'],
  // place-order refuses a booked pickup from a customer (pickup is always now). It used to refuse
  // an ASAP delivery too (delivery_must_be_scheduled); that rule is dropped with ASAP delivery's
  // return (docs/ASAP-AND-SCHEDULING-2026-10-25.md §1), and its sentence stays only for a
  // place-order still running the old rule while this storefront is already live. Both must come
  // before invalid_channel: place-order puts that code in the same body as a `hint`, so the
  // specific sentence wins instead of the generic one.
  ['delivery_must_be_scheduled', 'errors.order.deliveryMustBeScheduled'],
  ['pickup_is_asap_only', 'errors.order.pickupIsAsapOnly'],
  ['invalid_channel', 'errors.order.invalidChannel'],
  // Wire code is still `google_link_required` (other surfaces match on it), but the
  // rule is "prove who you are", and a verified email proves it just as well as
  // Google. Same sentence as the loyalty card's own notice, so it is the same message.
  ['google_link_required', 'checkout.loyalty.verifyRequired'],
  // A code or card that checked out on this page and was refused when the order was placed. The
  // submit handler reads these bodies first (promo: true, gift_card_changed) and shows the reason
  // in the code's own box; these lines are the fallback. They must precede
  // stale_client_refresh_required: place-order puts that code in the same body as a `hint`.
  ['gift_card_changed', 'errors.order.giftCardRefused'],
  ['promo_exhausted', 'errors.order.promoRefused'],
  ['promo_unavailable', 'errors.order.promoRefused'],
  ['per_customer_limit_reached', 'errors.order.promoRefused'],
  // A set whose contents are no longer all on sale. Normally the line is taken out (see
  // refusedCartPart); this is the sentence when no line uses it any more. Ahead of the stock codes,
  // which a combo refusal carries as its `reason`.
  ['combo_item_unavailable', 'errors.order.itemUnavailable'],
  ['combo_empty', 'errors.order.itemUnavailable'],
  // Reward redemption. The server re-prices every reward from the catalog, so
  // these fire when the catalog moved under a checkout that was already open.
  ['stale_client_refresh_required', 'errors.order.staleClientRefreshRequired'],
  ['reward_min_subtotal', 'errors.order.rewardMinSubtotal'],
  ['reward_item_not_in_cart', 'errors.order.rewardItemNotInCart'],
  ['reward_not_applicable', 'errors.order.rewardNotApplicable'],
  ['reward_unavailable', 'errors.order.rewardUnavailable'],
  ['insufficient_points', 'errors.order.insufficientPoints'],
  // The cart moved under the diner: something sold out, ran low or left the menu between the
  // cart page and this button. "Try again" alone would fail the same way every time.
  ['item_sold_out', 'errors.order.itemSoldOut'],
  ['insufficient_stock', 'errors.order.insufficientStock'],
  ['item_inactive', 'errors.order.itemUnavailable'],
  ['item_not_in_branch', 'errors.order.itemUnavailable'],
  ['combo_not_in_branch', 'errors.order.itemUnavailable'],
  ['combo_inactive', 'errors.order.itemUnavailable'],
  ['modifier_inactive', 'errors.order.itemUnavailable'],
  ['modifier_branch_mismatch', 'errors.order.itemUnavailable'],
  // 429 with retry_after_seconds 600: an immediate retry is exactly what will not work.
  ['rate_limited', 'errors.order.rateLimited'],
  ['redeem_requires_auth', 'errors.order.signInToOrder'],
  ['login_required', 'errors.order.signInToOrder'],
  ['empty_order', 'errors.order.emptyOrder'],
  // place-order folds the same selection into one line before pricing, and holds that line to 99.
  // The cart caps every add there too, so this is reached only by a cart older than that cap.
  ['invalid_quantity', 'errors.order.quantityTooHigh'],
  ['customer_phone_required', 'errors.order.phoneRequired'],
  ['delivery_address_required', 'errors.order.addressRequired'],
  // Same sentence as billing_inactive: to the diner both mean "not taking orders online now".
  ['branch_not_found_or_inactive', 'errors.order.billingInactive'],
];

/**
 * Sentences reworded for an ASAP delivery. Its timing is "now", so a refusal phrased about "the
 * time you picked" would send the diner looking for a time they never chose. The code is the
 * same either way: orders_enforce_delivery_hours judges coalesce(scheduled_for, now()).
 */
export const ASAP_ORDER_ERRORS: Record<string, string> = {
  'errors.order.deliveryNotAvailableAtThatTime': 'errors.order.deliveryNotAvailableNow',
};

/**
 * The same, for an ASAP delivery when no time can be booked instead (scheduling off, or no slot
 * left): "choose a delivery time" would point at a picker that is not there.
 */
export const ASAP_NO_BOOKING_ORDER_ERRORS: Record<string, string> = {
  'errors.order.deliveryNotAvailableAtThatTime': 'errors.order.deliveryNotAvailableNowNoBooking',
};

/**
 * The message key for a place-order failure, or null when it carries no code we know.
 * `asap`: the order was an ASAP delivery (no scheduled_for), which picks the "right now" wording
 * where the two differ (ASAP_ORDER_ERRORS). `bookable`: a delivery time could be chosen instead;
 * false picks the wording that does not offer one (ASAP_NO_BOOKING_ORDER_ERRORS).
 */
export function orderErrorKey(
  msg: string,
  context: { asap?: boolean; bookable?: boolean } = {},
): string | null {
  const key = orderErrorKeyFor(msg);
  if (!key || !context.asap) return key;
  const table = context.bookable === false ? ASAP_NO_BOOKING_ORDER_ERRORS : ASAP_ORDER_ERRORS;
  return table[key] ?? key;
}

function orderErrorKeyFor(msg: string): string | null {
  // placeOrder throws `place_order_failed:<status>:<body>`. An entitlement refusal names its
  // feature in a separate field ({"error":"feature_not_entitled","feature":"delivery"}), so it is
  // matched as `feature_not_entitled:delivery`; everything else is matched on the text as sent.
  let subject = msg;
  const body = msg.replace(/^place_order_failed:\d+:/, '');
  try {
    const parsed = JSON.parse(body) as { error?: unknown; feature?: unknown };
    if (parsed.error === 'feature_not_entitled' && typeof parsed.feature === 'string') {
      subject = `feature_not_entitled:${parsed.feature} ${msg}`;
    }
  } catch {
    // Not JSON (a network failure, a gateway page): match the text as it is.
  }
  for (const [code, key] of ORDER_ERRORS) {
    if (subject.includes(code)) return key;
  }
  return null;
}

/** The JSON body of a place-order refusal (`place_order_failed:<status>:<body>`), or null. */
export function placeOrderBody(msg: string): Record<string, unknown> | null {
  const match = /^place_order_failed:\d+:([\s\S]*)$/.exec(msg);
  if (!match) return null;
  try {
    const parsed: unknown = JSON.parse(match[1] ?? '');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The item, combo or option a place-order refusal names, when it names one:
 * 400 {"error":"modifier_inactive"|"modifier_branch_mismatch","option_id"},
 * {"error":"item_not_in_branch"|"item_inactive","item_id"},
 * {"error":"combo_not_in_branch"|"combo_inactive","combo_id"} and
 * 409 {"error":"combo_item_unavailable"|"combo_empty","combo_id"} (a set with a dish that is gone,
 * sold out or short on stock, or with nothing in it).
 *
 * Read from the parsed body's `error` field, not by substring: combo_not_in_branch carries
 * `"hint":"item_not_in_branch"` in the same body.
 */
export function refusedCartPart(msg: string): CartPart | null {
  const body = placeOrderBody(msg);
  if (!body) return null;
  const idOf = (value: unknown) => (typeof value === 'string' && value ? value : null);
  let kind: CartPart['kind'];
  let id: string | null;
  switch (body.error) {
    case 'modifier_inactive':
    case 'modifier_branch_mismatch':
      kind = 'option';
      id = idOf(body.option_id);
      break;
    case 'item_not_in_branch':
    case 'item_inactive':
      kind = 'item';
      id = idOf(body.item_id);
      break;
    case 'combo_not_in_branch':
    case 'combo_inactive':
    case 'combo_item_unavailable':
    case 'combo_empty':
      kind = 'combo';
      id = idOf(body.combo_id);
      break;
    default:
      return null;
  }
  return id ? { kind, id } : null;
}
