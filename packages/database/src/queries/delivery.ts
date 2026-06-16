import type { FavornomsClient } from '../client-type';

// Delivery quoting. The quote_delivery RPC is server-authoritative: the same
// formula runs inside place-order, so what the customer sees at checkout is
// exactly what the order records.

export type DeliveryQuote =
  | {
      deliverable: true;
      distance_km: number;
      fee: number;
      eta_min: number;
      surge: number;
    }
  | {
      deliverable: false;
      reason: 'invalid_coordinates' | 'branch_unavailable' | 'out_of_range';
      distance_km?: number;
      radius_km?: number;
    };

export async function quoteDelivery(
  supabase: FavornomsClient,
  branchId: string,
  lat: number,
  lng: number,
): Promise<DeliveryQuote | null> {
  const { data, error } = await supabase.rpc('quote_delivery', {
    p_branch_id: branchId,
    p_lat: lat,
    p_lng: lng,
  } as never);
  if (error || data == null) return null;
  return data as unknown as DeliveryQuote;
}
