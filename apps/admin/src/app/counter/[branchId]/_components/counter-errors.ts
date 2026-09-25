/**
 * Why place-order refused a sale, in words a cashier can act on with a customer waiting.
 *
 * The till used to match a dozen codes by substring and call everything else "That order was
 * refused". The owner's "error when paying at the counter" was exactly that: every delivery rung
 * up here failed with delivery_address_required, which had no entry, so the screen said "refused"
 * and nothing about the missing address. Codes are now read from the response body and matched
 * exactly; one that is still unknown shows its machine code, so a photo of the screen is enough
 * for support to know what happened.
 *
 * The storefront keeps its own table for the same codes, phrased for a diner. This one names the
 * till's remedies -- the Pause switch on the kitchen board, an 86'd dish, Branch settings.
 */

/** Message keys under `counter.errors`. */
export type CounterErrorKey =
  | 'branchClosedAtTime'
  | 'branchClosed'
  | 'branchInactive'
  | 'rateLimited'
  | 'itemSoldOut'
  | 'insufficientStock'
  | 'itemInactive'
  | 'itemNotInBranch'
  | 'invalidQuantity'
  | 'modifierInactive'
  | 'comboUnavailable'
  | 'comboItemUnavailable'
  | 'comboEmpty'
  | 'staleClient'
  | 'paymentMethodNotAccepted'
  | 'invalidPaymentMethod'
  | 'transferNotConfigured'
  | 'tableRequired'
  | 'tableNotInBranch'
  | 'tableSessionClosed'
  | 'deliveryAddressRequired'
  | 'dropoffRequired'
  | 'customerPhoneRequired'
  | 'deliveryOutOfRange'
  | 'deliveryNotAvailableNow'
  | 'deliveryMustBeScheduled'
  | 'emptyOrder'
  | 'invalidChannel'
  | 'insufficientPoints'
  | 'giftCardChanged'
  | 'featureNotEntitled'
  | 'invalidDiscount'
  | 'invalidPhone'
  | 'notStaffHere'
  | 'orderInsertFailed'
  | 'lookupFailed'
  | 'network'
  | 'unknown';

/** place-order's `error` codes. Exact matches only -- several codes contain others. */
const CODES: Record<string, CounterErrorKey> = {
  branch_closed_at_scheduled_time: 'branchClosedAtTime',
  branch_closed: 'branchClosed',
  branch_paused: 'branchClosed',
  branch_not_found_or_inactive: 'branchInactive',
  rate_limited: 'rateLimited',
  item_sold_out: 'itemSoldOut',
  insufficient_stock: 'insufficientStock',
  item_inactive: 'itemInactive',
  item_not_in_branch: 'itemNotInBranch',
  invalid_quantity: 'invalidQuantity',
  modifier_inactive: 'modifierInactive',
  modifier_branch_mismatch: 'modifierInactive',
  combo_inactive: 'comboUnavailable',
  combo_not_in_branch: 'comboUnavailable',
  combo_item_unavailable: 'comboItemUnavailable',
  combo_empty: 'comboEmpty',
  stale_client_refresh_required: 'staleClient',
  payment_method_not_accepted: 'paymentMethodNotAccepted',
  invalid_payment_method: 'invalidPaymentMethod',
  transfer_not_configured: 'transferNotConfigured',
  table_required: 'tableRequired',
  table_not_in_branch: 'tableNotInBranch',
  session_branch_mismatch: 'tableNotInBranch',
  table_session_closed: 'tableSessionClosed',
  table_session_changed: 'tableSessionClosed',
  session_table_mismatch: 'tableSessionClosed',
  delivery_address_required: 'deliveryAddressRequired',
  dropoff_required: 'dropoffRequired',
  dropoff_other_required: 'dropoffRequired',
  customer_phone_required: 'customerPhoneRequired',
  delivery_out_of_range: 'deliveryOutOfRange',
  delivery_not_available_at_that_time: 'deliveryNotAvailableNow',
  delivery_must_be_scheduled: 'deliveryMustBeScheduled',
  pickup_is_asap_only: 'invalidChannel',
  empty_order: 'emptyOrder',
  invalid_channel: 'invalidChannel',
  insufficient_points: 'insufficientPoints',
  gift_card_changed: 'giftCardChanged',
  // Normally answered by describeBillingError first; kept so the till never says "unknown".
  feature_not_entitled: 'featureNotEntitled',
  delivery_not_entitled: 'featureNotEntitled',
  // The till's discount and phone, checked again by place-order.
  invalid_discount: 'invalidDiscount',
  invalid_discount_percent: 'invalidDiscount',
  invalid_phone: 'invalidPhone',
  invalid_customer_phone: 'invalidPhone',
  // The customer record a looked-up number found belongs to another branch.
  customer_branch_mismatch: 'invalidPhone',
  // The caller is not staff at THIS branch, or the session is gone. place-order refuses a staff
  // sale outright then, rather than filing it as a diner's.
  login_required: 'notStaffHere',
  sign_in_required: 'notStaffHere',
  not_staff_at_branch: 'notStaffHere',
  discount_requires_staff: 'notStaffHere',
  forbidden: 'notStaffHere',
  table_not_seated: 'tableSessionClosed',
  order_insert_failed: 'orderInsertFailed',
  order_items_insert_failed: 'orderInsertFailed',
  credit_reservation_failed: 'orderInsertFailed',
  item_lookup_failed: 'lookupFailed',
  combo_lookup_failed: 'lookupFailed',
  modifier_lookup_failed: 'lookupFailed',
  staff_check_failed: 'lookupFailed',
  promo_lookup_failed: 'lookupFailed',
  gift_card_lookup_failed: 'lookupFailed',
};
// A Map, not an object lookup: a body saying {"error":"toString"} must not find Object.prototype.
const CODE_TO_KEY = new Map<string, CounterErrorKey>(Object.entries(CODES));

/** Keys that are the server's own failure rather than a rule: worth the code on screen too. */
const SHOW_CODE: ReadonlySet<CounterErrorKey> = new Set(['orderInsertFailed', 'lookupFailed', 'unknown']);

export interface PlaceOrderFailure {
  /** HTTP status, or null when the request never got an answer. */
  status: number | null;
  /** The body's `error`, or null. */
  code: string | null;
  /** The parsed body, when it was JSON. */
  body: Record<string, unknown> | null;
}

/**
 * Read what placeOrder() threw: `place_order_failed:<status>:<body>` for an answer, anything else
 * (a TypeError from fetch) when the request never got one.
 */
export function parsePlaceOrderFailure(raw: string): PlaceOrderFailure {
  const m = /^place_order_failed:(\d+):([\s\S]*)$/.exec(raw ?? '');
  if (!m) return { status: null, code: null, body: null };
  const status = Number(m[1]);
  const text = m[2] ?? '';
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const body = parsed as Record<string, unknown>;
      const code = typeof body.error === 'string' ? body.error : null;
      return { status, code, body };
    }
  } catch {
    // Not JSON: a gateway error page or a plain-text 500.
  }
  // Last resort for a body that is not JSON: the longest known code it mentions.
  const known = [...CODE_TO_KEY.keys()]
    .sort((a, b) => b.length - a.length)
    .find((code) => text.includes(code));
  return { status, code: known ?? null, body: null };
}

export interface CounterErrorDescription {
  key: CounterErrorKey;
  /** The machine code, when it is worth showing under the message. */
  code: string | null;
  /** The ids the body names, so the message can say which dish. */
  itemId: string | null;
  optionId: string | null;
  comboId: string | null;
  available: number | null;
}

const str = (v: unknown) => (typeof v === 'string' && v ? v : null);

export function describeCounterFailure(f: PlaceOrderFailure): CounterErrorDescription {
  const base = {
    itemId: str(f.body?.item_id),
    optionId: str(f.body?.option_id),
    comboId: str(f.body?.combo_id),
    available: typeof f.body?.available === 'number' ? (f.body.available as number) : null,
  };
  if (f.status === null) return { key: 'network', code: null, ...base };
  const key = (f.code && CODE_TO_KEY.get(f.code)) || 'unknown';
  const shown = f.code ?? (f.status ? `http_${f.status}` : null);
  return { key, code: SHOW_CODE.has(key) ? shown : null, ...base };
}

/**
 * Server failures place-order answers before any order exists, or after deleting the one it had
 * just inserted (a failed order_items insert or credit reservation takes the order with it).
 */
const NO_ORDER_SERVER_CODES: ReadonlySet<string> = new Set([
  'order_insert_failed',
  'order_items_insert_failed',
  'credit_reservation_failed',
  'item_lookup_failed',
  'combo_lookup_failed',
  'modifier_lookup_failed',
  'staff_check_failed',
  'promo_lookup_failed',
  'gift_card_lookup_failed',
]);

/**
 * Whether the order might exist after all.
 *
 * Only a refusal place-order itself spelled out proves nothing was placed. A dropped connection,
 * a gateway timeout or a 5xx page can all follow a successful insert, and telling the cashier to
 * ring the sale up again then makes a second order -- and for a QR sale, a second transfer.
 */
export function orderMayExist(f: PlaceOrderFailure): boolean {
  if (f.status === null) return true;
  if (f.status < 500) return f.code === null;
  return !(f.code && NO_ORDER_SERVER_CODES.has(f.code));
}

/** Message keys under `counter.settle`: why record_counter_transfer did not record the payment. */
export type SettleErrorKey =
  | 'authRequired'
  | 'orderNotFound'
  | 'forbidden'
  | 'notCounterOrder'
  | 'paymentNotFound'
  | 'paymentNotSettleable'
  | 'orderNotSettleable'
  | 'onlineCardUnpaid'
  | 'failed';

/** record_counter_transfer's raised codes. */
const SETTLE_CODES = new Map<string, SettleErrorKey>([
  ['auth_required', 'authRequired'],
  ['order_not_found', 'orderNotFound'],
  ['forbidden', 'forbidden'],
  ['not_a_counter_order', 'notCounterOrder'],
  ['payment_not_found', 'paymentNotFound'],
  ['payment_not_settleable', 'paymentNotSettleable'],
  ['order_not_settleable', 'orderNotSettleable'],
  // A diner's online card order that Stripe has not been paid for: only Stripe may settle its
  // payment (stripe_payment_server_only) and it cannot move on unpaid (card_payment_not_completed).
  // The till cannot fix that, so the cashier is told to cancel it and ring the sale up again.
  ['stripe_payment_server_only', 'onlineCardUnpaid'],
  ['card_payment_not_completed', 'onlineCardUnpaid'],
]);

/** Asking again cannot change these answers; the others (a lapsed session, a dropped call) can. */
const SETTLE_PERMANENT: ReadonlySet<SettleErrorKey> = new Set([
  'orderNotFound',
  'forbidden',
  'notCounterOrder',
  'paymentNotFound',
  'paymentNotSettleable',
  'orderNotSettleable',
  'onlineCardUnpaid',
]);

export interface SettleError {
  key: SettleErrorKey;
  /** The code to show under the sentence: the database's own, or null. */
  code: string | null;
  /** True when "Record payment" can only fail the same way again. */
  permanent: boolean;
}

/** Read a record_counter_transfer failure (PostgREST's `message` is the raised code). */
export function describeSettleError(message: string | null | undefined): SettleError {
  const text = (message ?? '').trim();
  // Longest first, as for place-order's codes, so a code that contains another always wins.
  const code = [...SETTLE_CODES.keys()]
    .sort((a, b) => b.length - a.length)
    .find((c) => text === c || text.includes(c));
  const key = (code && SETTLE_CODES.get(code)) || 'failed';
  const shown = code ?? (/^[a-z_]+$/.test(text) ? text : null);
  return { key, code: shown, permanent: SETTLE_PERMANENT.has(key) };
}
