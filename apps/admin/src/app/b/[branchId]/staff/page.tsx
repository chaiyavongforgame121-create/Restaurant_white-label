import { getServerClient } from '@favornoms/database/server';
import { StaffView } from './_components/staff-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function StaffPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();

  if (!branch) return null;

  const { data: staff } = await supabase
    .from('staff_members')
    .select('id, role, status, invited_email, branch_id, created_at, accepted_at, user_id')
    .eq('restaurant_id', branch.restaurant_id)
    .order('created_at', { ascending: false });

  return (
    <StaffView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      branchName={branch.name}
      initialStaff={staff ?? []}
    />
  );
}
