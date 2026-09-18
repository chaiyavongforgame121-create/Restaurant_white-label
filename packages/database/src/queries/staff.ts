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
    /** 'link' sends nothing and returns accept_url to share; 'email' mails the invitation. */
    delivery?: 'link' | 'email';
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
    /** Only on email delivery. */
    redirect_to?: string;
    emailed: boolean;
    already_registered?: boolean;
    delivery?: 'link' | 'email';
    /** The invitation page to share. Missing only from an invite-staff deployed before links. */
    accept_url?: string;
  };
}

/** The invitation page for a pending row, built on this origin (the back office that shows it). */
export function staffInviteUrl(origin: string, staffId: string): string {
  return `${origin.replace(/\/$/, '')}/invite/accept?staff_id=${staffId}&openExternalBrowser=1`;
}

/**
 * Deletes a pending, unclaimed invitation. Owner or admin of the restaurant only, and only the
 * owner may cancel an admin invitation. Throws `cancel_invite_failed:<reason>`.
 */
export async function cancelStaffInvite(supabase: FavornomsClient, staffId: string): Promise<void> {
  const { error } = await supabase.rpc('cancel_staff_invite', { p_staff_id: staffId });
  if (error) throw new Error(`cancel_invite_failed:${error.message}`);
}

/**
 * True when inviteStaff failed because that email already works at the branch it was invited to,
 * or at every branch (an owner, or a restaurant-wide row). invite-staff keeps one invitation per
 * (restaurant, email, branch), so an employee of another branch CAN be invited here; this is only
 * the case where there is nothing to add.
 */
export function isStaffAlreadyActiveError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('invite_staff_failed:409:') &&
    err.message.includes('already_active')
  );
}

/** True when inviteStaff failed because that email is suspended at this branch: bringing them
 *  back is Reactivate on the staff list, not a new invitation. */
export function isStaffAlreadySuspendedError(err: unknown): boolean {
  return (
    err instanceof Error &&
    err.message.startsWith('invite_staff_failed:409:') &&
    err.message.includes('already_suspended')
  );
}

/**
 * Suspends, reactivates or removes a team member through set_staff_status, which enforces who
 * may (staff.manage where the row works; only the owner changes an owner or admin; nobody
 * changes their own row; the last owner stays) and writes the audit row. A removed row is final:
 * the person is invited again to come back. Throws `set_staff_status_failed:<reason>`.
 */
export async function setStaffStatus(
  supabase: FavornomsClient,
  staffId: string,
  status: 'active' | 'suspended' | 'removed',
): Promise<{ changed: boolean }> {
  const { data, error } = await supabase.rpc('set_staff_status', {
    p_staff_id: staffId,
    p_status: status,
  });
  if (error) throw new Error(`set_staff_status_failed:${error.message}`);
  const d = (data ?? {}) as Record<string, unknown>;
  return { changed: d.changed !== false };
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

/** What an invitation link is for, readable before anyone is signed in. */
export interface StaffInvite {
  status: StaffStatus;
  role: StaffRole;
  /** Only while the invitation is still open. */
  invitedEmail: string | null;
  restaurantName: string;
  branchName: string | null;
}

export async function getStaffInvite(
  supabase: FavornomsClient,
  staffId: string,
): Promise<StaffInvite | null> {
  const { data, error } = await supabase.rpc('get_staff_invite', { p_staff_id: staffId });
  if (error || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  return {
    status: d.status as StaffStatus,
    role: d.role as StaffRole,
    invitedEmail: typeof d.invited_email === 'string' ? d.invited_email : null,
    restaurantName: String(d.restaurant_name ?? ''),
    branchName: typeof d.branch_name === 'string' ? d.branch_name : null,
  };
}

/**
 * Called from /invite/accept once the invitee is signed in. Claims the pending staff_members row
 * for this account through accept_staff_invite(), which checks the confirmed email against the
 * invited address. It used to be a direct UPDATE from the browser, which RLS (no policy lets an
 * invitee update a row) and the role-escalation trigger (no self status change) both refused, so
 * it matched zero rows and failed with "Cannot coerce the result to a single JSON object".
 */
export async function acceptStaffInvite(supabase: FavornomsClient, staffId: string) {
  const { data, error } = await supabase.rpc('accept_staff_invite', { p_staff_id: staffId });
  if (error) throw new Error(`accept_invite_failed:${error.message}`);
  const d = (data ?? {}) as Record<string, unknown>;
  return {
    id: String(d.staff_id ?? staffId),
    restaurant_id: String(d.restaurant_id ?? ''),
    branch_id: typeof d.branch_id === 'string' ? d.branch_id : null,
    role: d.role as StaffRole,
    alreadyAccepted: d.already_accepted === true,
  };
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
