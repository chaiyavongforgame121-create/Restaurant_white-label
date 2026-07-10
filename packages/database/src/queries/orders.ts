import type { FavornomsClient } from '../client-type';
import { getSupabaseEnv } from '../env';

export interface PlaceOrderInput {
  branch_id: string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
  customer_name: string;
  customer_phone: string;
  delivery_address?: {
    line1: string;
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    notes?: string;
    lat?: number;
    lng?: number;
  };
  saved_address_id?: string;
  customer_notes?: string;
  payment_method: 'card' | 'cash';
  redeem_points?: number;
  tip_amount?: number;
  promo_code?: string;
  table_id?: string;
  scheduled_for?: string;
  gift_card_code?: string;
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
  discount_amount?: number;
  payment_id: string | null;
  payment_method: string;
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
  const { data } = await supabase
    .from('orders')
    .select(
      `id, order_number, branch_id, channel, status, total, subtotal,
       delivery_fee, service_fee, customer_name, customer_phone,
       delivery_address, customer_notes, created_at, confirmed_at, completed_at,
       order_items(id, item_name, item_image_url, unit_price, quantity, subtotal),
       deliveries(id, status, driver_id, distance_km, estimated_duration_min, assigned_at, accepted_at, picked_up_at, delivered_at,
         driver_lat, driver_lng, driver_location_updated_at, current_eta_min, arriving_at, dropoff_lat, dropoff_lng, batch_seq)`,
    )
    .eq('branch_id', branchId)
    .eq('order_number', orderNumber)
    .maybeSingle();
  return data;
}
