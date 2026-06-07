import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { AccessDenied } from './_components/access-denied';

const POS_ROLES = ['owner', 'manager', 'cashier'] as const;

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function POSBranchLayout({ params, children }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) {
    redirect(`/login?next=${encodeURIComponent(`/b/${branchId}`)}`);
  }

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) {
    return <AccessDenied reason="Branch not found." showSignOut={false} />;
  }

  const { data: membership } = await supabase
    .from('staff_members')
    .select('id, role, branch_id, status')
    .eq('user_id', userData.user.id)
    .eq('restaurant_id', branch.restaurant_id)
    .eq('status', 'active')
    .in('role', [...POS_ROLES])
    .or(`branch_id.eq.${branchId},branch_id.is.null`)
    .maybeSingle();

  if (!membership) {
    return (
      <AccessDenied
        reason={`Your account doesn't have POS access for ${branch.name}. Ask your manager to invite you as cashier or manager.`}
      />
    );
  }

  return <>{children}</>;
}
