import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin } from '@favornoms/database/queries';
import { OnboardingWizard, type ExistingMembership } from './_components/onboarding-wizard';

// The root page's ladder, so the notice names the same restaurant '/' would open.
const ROLE_PRIORITY = ['owner', 'admin', 'manager', 'cashier', 'server', 'kitchen', 'staff', 'driver'];

export default async function OnboardingPage() {
  const supabase = await getServerClient();
  const { data: userData } = await supabase.auth.getUser();
  // Checked before anything renders. The wizard used to find out only when Launch was
  // pressed, so a signed-out visitor filled in all three steps and then lost every field on
  // the way to /login.
  if (!userData.user) redirect('/login?next=/onboarding');

  const { data: memberships } = await supabase
    .from('staff_members')
    .select('branch_id, restaurant_id, role')
    .eq('user_id', userData.user.id)
    .eq('status', 'active');

  const chosen = [...(memberships ?? [])].sort(
    (a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role),
  )[0];

  if (!chosen) {
    // Same guard as the root page. The platform owner is staff of nobody, so without it a
    // typed or bookmarked /onboarding hands the platform account a real trial restaurant.
    if (await isPlatformAdmin(supabase)) redirect('/platform');
    // Same as the root page: a typed or bookmarked /onboarding must not let an invitee create a
    // restaurant of their own while their invitation waits (its owner membership would then
    // outrank the invited role at every sign-in).
    const { data: pendingInvite } = await supabase.rpc('my_pending_staff_invite');
    if (pendingInvite) redirect(`/invite/accept?staff_id=${pendingInvite}`);
    return <OnboardingWizard existing={null} />;
  }

  // Someone who already runs a restaurant and opens this page almost always wants another
  // location, and the wizard would instead build a second restaurant beside the first —
  // separate menu, separate billing, and (for an owner) no trial. The notice says so first.
  const restaurantId = chosen.restaurant_id;
  const [restaurantRes, firstBranchRes] = restaurantId
    ? await Promise.all([
        supabase.from('restaurants').select('name').eq('id', restaurantId).maybeSingle(),
        supabase
          .from('branches')
          .select('id')
          .eq('restaurant_id', restaurantId)
          .eq('is_active', true)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ])
    : [null, null];

  // create_branch accepts owner and admin only, so only they are pointed at Add branch.
  const canAddBranch = chosen.role === 'owner' || chosen.role === 'admin';
  const branchId = chosen.branch_id ?? firstBranchRes?.data?.id ?? null;

  const existing: ExistingMembership = {
    restaurantName: restaurantRes?.data?.name ?? null,
    ownsRestaurant: (memberships ?? []).some((m) => m.role === 'owner'),
    canAddBranch,
    addBranchHref: canAddBranch && branchId ? `/b/${branchId}/brands` : null,
  };

  return <OnboardingWizard existing={existing} />;
}
