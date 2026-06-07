import { redirect, notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';

/**
 * Gate a branch-scoped route to a set of staff roles.
 * Mirrors the membership check in the branch admin layout but lets each
 * surface (dashboard / kitchen / counter) allow a different role set.
 * Returns `membership: null` when the signed-in user lacks access — the
 * caller renders <AccessDenied>. Redirects to /login when unauthenticated.
 */
export async function requireBranchRole(
  branchId: string,
  roles: readonly string[],
  nextPath: string,
) {
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

  const { data: membership } = await supabase
    .from('staff_members')
    .select('id, role, branch_id')
    .eq('user_id', userData.user.id)
    .eq('restaurant_id', branch.restaurant_id)
    .eq('status', 'active')
    .in('role', [...roles])
    .or(`branch_id.eq.${branchId},branch_id.is.null`)
    .maybeSingle();

  return { supabase, user: userData.user, branch, membership };
}
