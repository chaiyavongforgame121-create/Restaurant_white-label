import { notFound, redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getPlanStatus } from '@favornoms/database/queries';
import { Sidebar } from '@/components/sidebar';
import { AccessDenied } from '@/components/access-denied';

const ADMIN_ROLES = ['owner', 'manager'] as const;

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function BranchLayout({ params, children }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=${encodeURIComponent(`/b/${branchId}/dashboard`)}`);
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
    .in('role', [...ADMIN_ROLES])
    .or(`branch_id.eq.${branchId},branch_id.is.null`)
    .maybeSingle();

  if (!membership) {
    return (
      <AccessDenied
        title="No admin access"
        reason={`Your account isn't an owner or manager of ${branch.name}.`}
      />
    );
  }

  // Sibling branches (for the switcher) + current plan tier (for nav gating).
  const [{ data: branches }, planStatus] = await Promise.all([
    supabase
      .from('branches')
      .select('id, name')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('is_active', true)
      .order('name'),
    getPlanStatus(supabase, branch.restaurant_id),
  ]);

  return (
    <div className="flex min-h-dynamic-screen flex-col lg:flex-row">
      <Sidebar
        branchId={branchId}
        branchName={branch.name}
        branches={branches ?? []}
        tier={planStatus?.plan}
      />
      <main className="flex-1 lg:ml-0">{children}</main>
    </div>
  );
}
