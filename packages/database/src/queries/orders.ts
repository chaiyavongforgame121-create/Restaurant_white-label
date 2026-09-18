import type { FavornomsClient } from '../client-type';
import { getSupabaseEnv } from '../env';

export interface PlaceOrderInput {
  branch_id: string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
  customer_name: string;
  /**
   * The customer's number. A counter walk-in who gave none is sent as the placeholder
   * '+10000000000', which is never stored on or matched to a customer record. A delivery
   * rung up at the counter needs a real one (400 customer_phone_required): the rider calls it.
   */
  customer_phone: string;
  /**
   * Delivery orders only; `line1` is required (400 delivery_address_required).
   *
   * With `lat`/`lng` the fee comes from quote_delivery (409 delivery_out_of_range outside the
   * branch's radius). Without them the branch's flat `settings.delivery_fee` (default 3.99)
   * applies and no rider coordinates are stored, which is the counter's delivery with no pin.
   */
  delivery_address?: {
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    notes?: string;
    lat?: number;
    lng?: number;
    /**
     * Required for delivery orders from the storefront (400 dropoff_required). A staff-placed
     * order may leave it out and gets 'hand_to_me'.
     */
    dropoff_pref?: 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other';
    /** Required when dropoff_pref === 'other'; max 120 chars. */
    dropoff_other?: string;
    gate_code?: string;
    room?: string;
  };
  saved_address_id?: string;
  customer_notes?: string;
  payment_method: 'card' | 'cash' | 'transfer';
  /**
   * Which named reward from the merchant's catalog to spend points on.
   *
   * Replaces the old free-form `redeem_points`. Points are no longer a
   * general-purpose currency the diner can slide against any order — the
   * merchant decides what they buy, and the server prices the reward itself.
   * place-order rejects a payload that still carries `redeem_points`.
   */
  reward_id?: string;
  tip_amount?: number;
  promo_code?: string;
  table_id?: string;
  /**
   * Free-text table number for dine-in. place-order resolves it against the
   * branch's `tables` rows and fills `table_id` when it matches, so the kitchen
   * and floor plan see a real table instead of a string buried in the notes.
   * Required for dine-in orders placed from the customer storefront.
   */
  table_number?: string;
  /**
   * Which surface placed the order. Staff surfaces take walk-in dine-in orders
   * with no table, so the dine-in table rule applies to `web` only. Defaults to `web`.
   */
  source?: 'web' | 'counter' | 'pos';
  scheduled_for?: string;
  /** Good only at the branch that issued it; 409 gift_card_changed when it no longer covers the credit. */
  gift_card_code?: string;
  /**
   * Staff only (403 discount_requires_staff otherwise): a percentage 0..100 taken off the food
   * before tax and the card service fee, as min(subtotal, round2(subtotal x pct / 100)). Recorded
   * in orders.discount_amount and in audit_logs. 400 invalid_discount_percent when out of range.
   */
  discount_percent?: number;
  /**
   * Staff only: an E.164 number the customer gave at the till. When THIS branch has a customer
   * record with that number, the sale is filed under it (so it earns that branch's points); it is
   * never used to create or claim a record. Matched by digits, so a record stored as '6266386401'
   * or '(626) 638-6401' is found from '+16266386401'. 400 invalid_customer_phone when malformed;
   * the result's `customer_matched` says whether a record was found.
   */
  customer_lookup_phone?: string;
  items: Array<{
    menu_item_id: string;
    quantity: number;
    notes?: string;
    modifier_option_ids?: string[];
  }>;
  combos?: Array<{
    combo_id: string;
    quantity: number;
    notes?: string;
  }>;
}

export interface PlaceOrderResult {
  order_id: string;
  order_number: string;
  total: number;
  subtotal?: number;
  tax_amount?: number;
  /** Every discount on the order: the reward, the promo and the till's discount together. */
  discount_amount?: number;
  points_spent?: number;
  eta_min?: number | null;
  payment_id: string | null;
  payment_method: string;
  /** Present only when `customer_lookup_phone` was sent: whether it found this branch's customer. */
  customer_matched?: boolean;
}

/**
 * Calls the `place-order` Edge Function which recalculates totals
 * server-side per implementation.md §19.4 (never trust client prices).
 */
export async function placeOrder(
  supabase: FavornomsClient,
  input: PlaceOrderInput,
): Promise<PlaceOrderResult> {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;

  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/place-order`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken ?? publishableKey}`,
    },
    body: JSON.stringify(input),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`place_order_failed:${res.status}:${text}`);
  }
  return (await res.json()) as PlaceOrderResult;
}

export async function getOrderByNumber(
  supabase: FavornomsClient,
  branchId: string,
  orderNumber: string,
) {
  // session_id is what tells a round of a table sitting from every other order. The
  // tracking page needs it to know that a bumped round is not a finished meal: a seated
  // party is still ordering, and their bill is settled at the counter much later.
  const { data } = await supabase
    .from('orders')
    .select(
      `id, order_number, branch_id, channel, status, total, subtotal,
       delivery_fee, service_fee, customer_name, customer_phone,
       delivery_address, customer_notes, created_at, confirmed_at, completed_at,
       cancellation_reason, awaiting_payment, session_id,
       order_items(id, item_name, item_image_url, unit_price, quantity, subtotal),
       payments(id, method, status, proof_image_url, gateway_metadata),
       deliveries(id, status, driver_id, distance_km, estimated_duration_min, assigned_at, accepted_at, picked_up_at, delivered_at,
         driver_lat, driver_lng, driver_location_updated_at, current_eta_min, arriving_at, dropoff_lat, dropoff_lng, batch_seq)`,
    )
    .eq('branch_id', branchId)
    .eq('order_number', orderNumber)
    .maybeSingle();
  return data;
}
