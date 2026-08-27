import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { StaffView } from './_components/staff-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function StaffPage({ params }: Props) {
  const { branchId } = await params;
  // Handing out access is the one thing a day-to-day manager should not be able to do:
  // the page was previously reachable by anyone who cleared the back-office gate, so a
  // manager could invite themselves a second, higher-privileged account.
  const { supabase, branch, can } = await getBranchAccess(
    branchId,
    `/b/${branchId}/staff`,
  );

  if (!can('staff.manage')) {
    return (
      <AccessDenied
        title="No staff access"
        reason={`Only the owner or an admin can manage the team at ${branch.name}.`}
      />
    );
  }

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
