import type { FavornomsClient } from '../client-type';

// customer_addresses helpers. lat/lng are stored generated columns mirroring
// the PostGIS geo_location, so they read through normal RLS selects; writes
// go through the upsert_customer_address RPC (owner-checked, writes geography).

export interface SavedAddress {
  id: string;
  label: string | null;
  address_line1: string;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  delivery_notes: string | null;
  is_default: boolean | null;
  lat: number | null;
  lng: number | null;
}

export async function listCustomerAddresses(
  supabase: FavornomsClient,
  customerId: string,
): Promise<SavedAddress[]> {
  const { data } = await supabase
    .from('customer_addresses')
    .select(
      'id, label, address_line1, address_line2, city, state, postal_code, delivery_notes, is_default, lat, lng',
    )
    .eq('customer_id', customerId)
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: false });
  return (data ?? []) as SavedAddress[];
}

export interface UpsertAddressInput {
  customer_id: string;
  label?: string | null;
  line1: string;
  line2?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
  lat?: number | null;
  lng?: number | null;
  notes?: string | null;
  is_default?: boolean;
  /** Pass to update an existing address instead of inserting. */
  address_id?: string;
}

export async function upsertCustomerAddress(
  supabase: FavornomsClient,
  input: UpsertAddressInput,
): Promise<string | null> {
  const { data, error } = await supabase.rpc('upsert_customer_address', {
    p_customer_id: input.customer_id,
    p_label: input.label ?? null,
    p_line1: input.line1,
    p_line2: input.line2 ?? null,
    p_city: input.city ?? null,
    p_state: input.state ?? null,
    p_postal_code: input.postal_code ?? null,
    p_lat: input.lat ?? null,
    p_lng: input.lng ?? null,
    p_notes: input.notes ?? null,
    p_is_default: input.is_default ?? false,
    p_address_id: input.address_id ?? null,
  } as never);
  if (error) throw new Error(`upsert_address_failed:${error.message}`);
  return (data as string | null) ?? null;
}

/** Delete a saved address. RLS scopes the delete to the owning customer. */
export async function deleteCustomerAddress(
  supabase: FavornomsClient,
  addressId: string,
): Promise<void> {
  const { error } = await supabase.from('customer_addresses').delete().eq('id', addressId);
  if (error) throw new Error(`delete_address_failed:${error.message}`);
}
