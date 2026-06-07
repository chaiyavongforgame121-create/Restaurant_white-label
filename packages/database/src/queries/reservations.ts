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

/** Anyone may create a reservation; staff confirms it later. */
export async function createReservation(
  supabase: FavornomsClient,
  input: CreateReservationInput,
) {
  let customerId: string | null = null;
  const { data: userData } = await supabase.auth.getUser();
  if (userData.user) {
    const { data: c } = await supabase
      .from('customers')
      .select('id')
      .eq('user_id', userData.user.id)
      .eq('branch_id', input.branch_id)
      .maybeSingle();
    customerId = c?.id ?? null;
  }

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
