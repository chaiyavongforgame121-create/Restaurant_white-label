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
    role: 'admin' | 'manager' | 'cashier' | 'server' | 'kitchen' | 'driver' | 'staff';
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
  // `emailed` distinguishes the two outcomes the caller must word differently: a brand-new
  // account really does have to wait for mail, whereas someone who already had an account
  // was linked server-side and can sign in immediately. Telling the second group to "check
  // their inbox" sends them looking for an email that is deliberately never sent.
  return (await res.json()) as {
    ok: true;
    staff_id: string;
    redirect_to: string;
    emailed: boolean;
    already_registered?: boolean;
  };
}

/**
 * True when inviteStaff failed because that email is already an active member of the
 * restaurant. invite-staff keeps one row per restaurant and email and answers 409
 * already_active, which is exactly what an owner hits when trying to "invite" a cashier to
 * their second branch — that is a Branch access change, not an invite.
 */
export function isStaffAlreadyActiveError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('invite_staff_failed:409:') &&
    err.message.includes('already_active')
  );
}

/**
 * Moves an existing team member between one branch and every branch (`branchId` null).
 * Each staff row holds a single branch_id and nothing could change it after the invite, so a
 * branch-only cashier could never work at a second branch short of being made
 * restaurant-wide. The RPC enforces who may do this (owner rows are fixed, admin rows are
 * owner-only, the branch must be in the same restaurant) and writes the audit row.
 */
export async function setStaffBranchScope(
  supabase: FavornomsClient,
  staffId: string,
  branchId: string | null,
): Promise<void> {
  // set_staff_branch_scope is not in the generated types yet — thin typed escape.
  const rpcAny = supabase.rpc.bind(supabase) as unknown as (
    fn: string,
    args?: Record<string, unknown>,
  ) => Promise<{ error: { message: string } | null }>;
  const { error } = await rpcAny('set_staff_branch_scope', {
    p_staff_id: staffId,
    p_branch_id: branchId,
  });
  if (error) throw new Error(error.message);
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
