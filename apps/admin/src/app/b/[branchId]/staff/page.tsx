import { getTranslations } from 'next-intl/server';
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
  const { supabase, branch, can, role, user } = await getBranchAccess(
    branchId,
    `/b/${branchId}/staff`,
  );

  if (!can('staff.manage')) {
    const t = await getTranslations('staff');
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [{ data: staff }, { data: branches }, { data: restaurant }] = await Promise.all([
    supabase
      .from('staff_members')
      .select('id, role, status, invited_email, branch_id, created_at, accepted_at, user_id')
      .eq('restaurant_id', branch.restaurant_id)
      .order('created_at', { ascending: false }),
    supabase
      .from('branches')
      .select('id, name, is_active')
      .eq('restaurant_id', branch.restaurant_id)
      .order('name'),
    supabase
      .from('restaurants')
      .select('owner_user_id')
      .eq('id', branch.restaurant_id)
      .maybeSingle(),
  ]);

  // set_staff_branch_scope lets only an owner change an admin's branch access. The
  // restaurant's owner_user_id counts as the owner even without an owner staff row, the same
  // way capabilities.ts treats them.
  const viewerIsOwner = role === 'owner' || restaurant?.owner_user_id === user.id;

  return (
    <StaffView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      branchName={branch.name}
      initialStaff={staff ?? []}
      branches={branches ?? []}
      viewerIsOwner={viewerIsOwner}
    />
  );
}
