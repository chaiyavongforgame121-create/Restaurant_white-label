import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';
import { getSupabaseEnv } from '../env';

export type StaffRow = Database['public']['Tables']['staff_members']['Row'];
export type StaffRole = Database['public']['Enums']['staff_role'];
export type StaffStatus = Database['public']['Enums']['staff_status'];

export async function listStaffForRestaurant(
  supabase: FavornomsClient,
  restaurantId: string,
) {
  const { data } = await supabase
    .from('staff_members')
    .select('id, role, status, invited_email, branch_id, created_at, accepted_at, user_id')
    .eq('restaurant_id', restaurantId)
    .order('created_at', { ascending: false });
  return data ?? [];
}

/** Calls the `invite-staff` Edge Function. Must be invoked by an authenticated owner/manager. */
export async function inviteStaff(
  supabase: FavornomsClient,
  input: {
    email: string;
    role: 'manager' | 'cashier' | 'kitchen' | 'staff';
    restaurant_id: string;
    branch_id?: string | null;
    permissions?: string[];
  },
) {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new Error('not_authenticated');

  const { url, publishableKey } = getSupabaseEnv();
  const res = await fetch(`${url}/functions/v1/invite-staff`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: publishableKey,
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`invite_staff_failed:${res.status}:${text}`);
  }
  return (await res.json()) as { ok: true; staff_id: string; redirect_to: string };
}

/**
 * Called from /invite/accept after the user signs in via magic link.
 * Links the auth user to the pending staff_members row.
 */
export async function acceptStaffInvite(
  supabase: FavornomsClient,
  staffId: string,
) {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user?.email) throw new Error('no_email_on_user');

  const { data, error } = await supabase
    .from('staff_members')
    .update({
      user_id: user.user.id,
      accepted_at: new Date().toISOString(),
      status: 'active',
    })
    .eq('id', staffId)
    .eq('invited_email', user.user.email.toLowerCase())
    .select('id, restaurant_id, branch_id, role')
    .single();

  if (error) throw new Error(`accept_invite_failed:${error.message}`);
  return data;
}

export async function getMyStaffMemberships(supabase: FavornomsClient) {
  const { data: user } = await supabase.auth.getUser();
  if (!user.user) return [];
  const { data } = await supabase
    .from('staff_members')
    .select('id, role, status, restaurant_id, branch_id')
    .eq('user_id', user.user.id)
    .eq('status', 'active');
  return data ?? [];
}
