import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';

// Each staff role lands on its own surface after sign-in.
function landingPath(role: string, branchId: string): string {
  switch (role) {
    case 'kitchen':
      return `/kitchen/${branchId}`;
    case 'cashier':
    case 'staff':
      return `/counter/${branchId}`;
    default: // owner, manager
      return `/b/${branchId}/dashboard`;
  }
}

// When a user holds several memberships, the highest-privilege one wins the landing.
const ROLE_PRIORITY = ['owner', 'manager', 'cashier', 'kitchen', 'staff'];

export default async function RootPage() {
  const supabase = await getServerClient();
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) redirect('/login');

  const { data: memberships } = await supabase
    .from('staff_members')
    .select('branch_id, restaurant_id, role')
    .eq('user_id', userData.user.id)
    .eq('status', 'active');

  if (!memberships || memberships.length === 0) redirect('/onboarding');

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
