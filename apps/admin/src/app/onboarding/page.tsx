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

  // An owner known only through restaurants.owner_user_id has no staff row, yet it is their
  // restaurant: create_restaurant_with_branch gives such an account no second trial, and /signup
  // now signs an existing account straight in and lands here. The owner_user_id filter matters,
  // since restaurants_public_read shows every restaurant with a live branch to anyone.
  const [{ data: memberships }, { data: owned }] = await Promise.all([
    supabase
      .from('staff_members')
      .select('branch_id, restaurant_id, role')
      .eq('user_id', userData.user.id)
      .eq('status', 'active'),
    supabase
      .from('restaurants')
      .select('id, name')
      .eq('owner_user_id', userData.user.id)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);

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
    // Their own restaurant, with no staff row: the notice, as for any owner, instead of a bare
    // wizard that built a second restaurant with no trial.
    if (owned) {
      // Its first branch, an active one if any, as the root page lands them (a suspended
      // restaurant has none active, and its branch gates say why).
      const { data: ownedBranches } = await supabase
        .from('branches')
        .select('id, is_active')
        .eq('restaurant_id', owned.id)
        .order('created_at', { ascending: true });
      const ownedBranch = (ownedBranches ?? []).find((b) => b.is_active) ?? ownedBranches?.[0] ?? null;
      return (
        <OnboardingWizard
          existing={{
            restaurantName: owned.name ?? null,
            ownsRestaurant: true,
            canAddBranch: true,
            addBranchHref: ownedBranch ? `/b/${ownedBranch.id}/brands` : null,
          }}
        />
      );
    }
    // Passed from here rather than read in the browser, so the notice is in the server HTML and
    // hydrates without a flash or a mismatch.
    return <OnboardingWizard existing={null} signedInEmail={userData.user.email ?? null} />;
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

  // create_branch accepts the owner only (20261016100000_roles_core.sql: a new branch is billed
  // to the owner's subscription), so only they are pointed at Add branch.
  const canAddBranch = chosen.role === 'owner';
  const branchId = chosen.branch_id ?? firstBranchRes?.data?.id ?? null;

  const existing: ExistingMembership = {
    restaurantName: restaurantRes?.data?.name ?? null,
    // Owning a restaurant through owner_user_id alone counts too: no trial either way.
    ownsRestaurant: !!owned || (memberships ?? []).some((m) => m.role === 'owner'),
    canAddBranch,
    addBranchHref: canAddBranch && branchId ? `/b/${branchId}/brands` : null,
  };

  return <OnboardingWizard existing={existing} />;
}
