import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

export type ReservationRow = Database['public']['Tables']['reservations']['Row'];
export type ReservationStatus = ReservationRow['status'];

export interface CreateReservationInput {
  branch_id: string;
  customer_name: string;
  customer_phone: string;
  party_size: number;
  reserved_for: string; // ISO timestamp
  duration_minutes?: number;
  notes?: string;
}

/**
 * Creates a reservation for the signed-in diner; staff confirms it later.
 *
 * Sign-in is required, and not by choice: the insert below asks for the row back,
 * so Postgres applies the SELECT policy to it. The only diner-visible one is
 * `reservations_owner_read_own`, which matches on customer_id — a NULL there fails
 * the policy and aborts the whole statement with 42501, writing nothing. (A bare
 * insert with no RETURNING does succeed for anon; if anon booking is ever wanted
 * back, drop the .select() for that path rather than widening the policy.)
 */
export async function createReservation(
  supabase: FavornomsClient,
  input: CreateReservationInput,
) {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) throw new Error('reservation_failed:auth_required');
  // Customer identity is brand-scoped — `customers` is unique on
  // (restaurant_id, user_id) and branch_id only records the branch the row was born
  // at, never updated. Keying the lookup on branch_id therefore missed at every
  // sibling branch of a multi-branch restaurant, and the resulting NULL customer_id
  // is what made the insert fail. The RPC resolves restaurant_id from the branch
  // server-side and never keys on the typed phone number.
  const { data: cid, error: cidErr } = await supabase.rpc('get_or_create_my_customer', {
    p_branch_id: input.branch_id,
  });
  if (cidErr) throw new Error(`reservation_failed:${cidErr.message}`);
  const customerId = (cid as string | null) ?? null;
  if (!customerId) throw new Error('reservation_failed:customer_identity_unavailable');

  const { data, error } = await supabase
    .from('reservations')
    .insert({
      branch_id: input.branch_id,
      customer_id: customerId,
      customer_name: input.customer_name,
      customer_phone: input.customer_phone,
      party_size: input.party_size,
      reserved_for: input.reserved_for,
      duration_minutes: input.duration_minutes ?? 90,
      notes: input.notes ?? null,
      status: 'pending',
    })
    .select('id, status, reserved_for')
    .single();
  if (error) throw new Error(`reservation_failed:${error.message}`);
  return data;
}

export async function listReservationsForBranch(
  supabase: FavornomsClient,
  branchId: string,
  opts?: { from?: string; to?: string },
): Promise<ReservationRow[]> {
  let q = supabase
    .from('reservations')
    .select('*')
    .eq('branch_id', branchId)
    .order('reserved_for', { ascending: true });
  if (opts?.from) q = q.gte('reserved_for', opts.from);
  if (opts?.to) q = q.lte('reserved_for', opts.to);
  const { data } = await q;
  return data ?? [];
}

export async function setReservationStatus(
  supabase: FavornomsClient,
  reservationId: string,
  status: ReservationStatus,
  tableId?: string | null,
) {
  return supabase
    .from('reservations')
    .update({
      status,
      ...(tableId !== undefined ? { table_id: tableId } : {}),
    })
    .eq('id', reservationId);
}
