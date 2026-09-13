import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin } from '@favornoms/database/queries';

// Each staff role lands on its own surface after sign-in.
function landingPath(role: string, branchId: string): string {
  switch (role) {
    case 'kitchen':
      return `/kitchen/${branchId}`;
    case 'cashier':
    case 'server':
    case 'staff':
      return `/counter/${branchId}`;
    // A rider has no back-office surface at all; the driver app is a separate
    // deployment, so there is nothing here to land on but the sign-in explainer.
    case 'driver':
      return '/no-access';
    default: // owner, admin, manager
      return `/b/${branchId}/dashboard`;
  }
}

// When a user holds several memberships, the highest-privilege one wins the landing.
//
// Every staff_role value must appear here. A missing one gets indexOf === -1 and
// therefore sorts FIRST, ahead of owner — so an omission is not a cosmetic bug, it
// silently changes which membership decides where a multi-role user lands.
const ROLE_PRIORITY = ['owner', 'admin', 'manager', 'cashier', 'server', 'kitchen', 'staff', 'driver'];

export default async function RootPage() {
  const supabase = await getServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect('/login');

  const { data: memberships } = await supabase
    .from('staff_members')
    .select('branch_id, restaurant_id, role')
    .eq('user_id', userData.user.id)
    .eq('status', 'active');

  if (!memberships || memberships.length === 0) {
    // The platform owner is staff of nobody, so this branch used to send them straight into
    // the new-restaurant wizard on every sign-in — one press of Launch away from creating a
    // real trial restaurant owned by the platform account, with no link to their console.
    if (await isPlatformAdmin(supabase)) redirect('/platform');
    redirect('/onboarding');
  }

  const chosen = [...memberships].sort(
    (a, b) => ROLE_PRIORITY.indexOf(a.role) - ROLE_PRIORITY.indexOf(b.role),
  )[0]!;
  const role = chosen.role as string;

  let branchId = chosen.branch_id as string | null;
  if (!branchId && chosen.restaurant_id) {
    const { data: branch } = await supabase
      .from('branches')
      .select('id')
      .eq('restaurant_id', chosen.restaurant_id)
      .eq('is_active', true)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    branchId = branch?.id ?? null;
  }

  if (branchId) redirect(landingPath(role, branchId));
  redirect('/onboarding');
}
