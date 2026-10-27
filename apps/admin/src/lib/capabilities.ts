import 'server-only';
import { redirect, notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import {
  branchHasOrdersInProgress,
  getSubscriptionGate,
  subscriptionRedirect,
  type SubscriptionGate,
  type WhileLocked,
} from './subscription-gate';

/**
 * Named capabilities, mirroring `public.role_capabilities` in the database.
 *
 * The app used to gate on hardcoded role arrays (`ADMIN_ROLES = ['owner','manager']`),
 * which meant every new role had to be threaded through a dozen call sites and the
 * server-side truth lived in two places. Screens now ask for a capability; the matrix
 * that maps roles to capabilities lives in one table, and `private.staff_has_capability`
 * is the single predicate RLS policies use for the same question.
 *
 * These gates are UX: they decide what to render and stop an obvious wrong turn. RLS is
 * the actual boundary. Nothing here is load-bearing for security on its own.
 */
export type Capability =
  | 'backoffice.access'
  | 'dashboard.view'
  | 'orders.view'
  | 'orders.view.own'
  | 'orders.create'
  | 'orders.refund'
  | 'orders.cancel'
  | 'counter.access'
  | 'kitchen.access'
  | 'kitchen.status'
  | 'menu.manage'
  | 'menu.availability'
  | 'inventory.manage'
  | 'promos.manage'
  | 'promos.apply'
  | 'customers.view'
  | 'loyalty.manage'
  | 'payments.view'
  | 'payments.decide'
  /** Approve or reject a storefront transfer slip (decide_payment_proof): the cashier's "check
   *  the money arrived". Voiding and closing unpaid tables stay with payments.decide. */
  | 'payments.verify'
  | 'receipt.reprint'
  | 'delivery.manage'
  | 'drivers.manage'
  | 'reports.view'
  | 'staff.manage'
  | 'staff.timelog'
  | 'branch.settings'
  | 'brand.edit'
  | 'billing.manage'
  | 'hq.view'
  | 'driver.self';

export interface BranchAccess {
  supabase: Awaited<ReturnType<typeof getServerClient>>;
  user: { id: string; email?: string };
  branch: { id: string; restaurant_id: string; name: string };
  /** Everything this user may do at this branch. Empty for a signed-in stranger. */
  capabilities: Set<Capability>;
  /** staff_members.id — null for the restaurant's owner_user_id and platform admins,
   *  who legitimately hold access without a staff row. */
  staffId: string | null;
  role: string | null;
  can: (capability: Capability) => boolean;
  /** The restaurant's subscription as this request read it. `locked` past this call means the
   *  caller asked to handle it ('allow') or orders are still in progress ('ordersInProgress'). */
  subscription: SubscriptionGate;
}

export interface BranchAccessOptions {
  /** What this screen does while the subscription has ended; see WhileLocked. Left out, the
   *  person is sent to Plan & billing or /suspended/<branch>. */
  whileLocked?: WhileLocked;
}

/**
 * Resolve what the signed-in user may do at a branch.
 *
 * Redirects to /login when unauthenticated and 404s an unknown branch. When the restaurant's
 * subscription has ended it also sends a member of staff away (subscriptionRedirect), unless the
 * caller says otherwise: it is the one call every /b, /counter and /kitchen page and layout makes,
 * so a click inside the app cannot get around the lock (D1). Otherwise it always returns, with an
 * empty capability set when the user has no access. The caller decides whether that is an
 * <AccessDenied> or a narrower page.
 */
export async function getBranchAccess(
  branchId: string,
  nextPath: string,
  options: BranchAccessOptions = {},
): Promise<BranchAccess> {
  const supabase = await getServerClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  }

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  // One RPC for the capability set, plus the membership row for its id and role
  // (needed for audit columns like driver_approvals.reviewed_by). Neither depends on
  // the other, so they go together — this sits in front of every back-office page. The
  // subscription goes with them, read once per request however many callers ask.
  const [{ data: caps }, { data: memberships }, subscription] = await Promise.all([
    supabase.rpc('my_capabilities', { p_branch_id: branchId }),
    // An owner row covers every branch of its restaurant, whichever branch it was created at —
    // the same rule my_capabilities applies. Without the owner arm the owner of a second branch
    // had no row here, and the denial read "isn't a member of staff" to the restaurant's owner.
    // A list, not maybeSingle(): someone can hold an owner row and a branch row at once, and
    // maybeSingle() errors on two rows, which used to read as "no membership at all".
    supabase
      .from('staff_members')
      .select('id, role, branch_id')
      .eq('user_id', userData.user.id)
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active')
      .or(`branch_id.eq.${branchId},branch_id.is.null,role.eq.owner`),
    getSubscriptionGate(branchId),
  ]);
  const rows = memberships ?? [];
  // The row that best describes this person HERE: owner first, then this branch, then every-branch.
  const membership =
    rows.find((m) => m.role === 'owner') ??
    rows.find((m) => m.branch_id === branchId) ??
    rows.find((m) => m.branch_id === null) ??
    null;

  const capabilities = new Set((caps ?? []) as Capability[]);

  // Orders are asked about only when they decide something: a locked branch, someone who works
  // there, and a screen that stays open while orders are in progress.
  const ordersInProgress =
    subscription.locked && capabilities.size > 0 && options.whileLocked === 'ordersInProgress'
      ? await branchHasOrdersInProgress(branchId)
      : false;
  const away = subscriptionRedirect({
    branchId,
    locked: subscription.locked,
    capabilities,
    whileLocked: options.whileLocked,
    ordersInProgress,
  });
  if (away) redirect(away);

  return {
    supabase,
    user: { id: userData.user.id, email: userData.user.email },
    branch,
    capabilities,
    staffId: membership?.id ?? null,
    role: membership?.role ?? null,
    can: (c: Capability) => capabilities.has(c),
    subscription,
  };
}

/** Convenience for a page that needs exactly one capability. */
export async function requireCapability(
  branchId: string,
  capability: Capability,
  nextPath: string,
): Promise<BranchAccess & { allowed: boolean }> {
  const access = await getBranchAccess(branchId, nextPath);
  return { ...access, allowed: access.can(capability) };
}
