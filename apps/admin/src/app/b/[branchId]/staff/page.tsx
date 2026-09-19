import { getTranslations } from 'next-intl/server';
import { isPlatformAdmin } from '@favornoms/database/queries';
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

  // The restaurant's roster is read, and StaffView splits it: this branch's team, the people who
  // work at every branch, and (collapsed, read-only) the teams of other branches this viewer also
  // manages. It used to show everyone as "members at <this branch>", so Food Thai Thai listed
  // Hamburger's cashier and kitchen as its own. RLS still returns every branch's rows to anyone
  // with staff.manage somewhere in the restaurant, so the other teams are filtered below.
  const [{ data: staff }, { data: branches }, { data: restaurant }, platformAdmin] =
    await Promise.all([
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
      // set_staff_role counts a platform admin working as support as the owner; invite-staff does
      // not, so this only widens the role controls (roleChangeViewer), not the invite form.
      isPlatformAdmin(supabase),
    ]);

  // set_staff_branch_scope lets only an owner change an admin's branch access. The
  // restaurant's owner_user_id counts as the owner even without an owner staff row, the same
  // way capabilities.ts treats them.
  const viewerIsOwner = role === 'owner' || restaurant?.owner_user_id === user.id;
  // invite-staff lets an admin of one branch invite into that branch only; an owner or an admin
  // of every branch may also invite someone to all branches.
  const viewerRestaurantWide =
    viewerIsOwner ||
    (staff ?? []).some(
      (s) => s.user_id === user.id && s.status === 'active' && s.branch_id === null && s.role === 'admin',
    );

  // The other branches' teams link to their own Staff page only where the viewer can open it.
  // Restaurant-wide authority opens every branch; anyone else is asked per branch they have a row
  // at, through my_capabilities, the same answer that page gates on.
  let staffBranchIds: string[];
  if (viewerRestaurantWide) {
    staffBranchIds = (branches ?? []).map((b) => b.id);
  } else {
    const candidates = [
      ...new Set(
        (staff ?? [])
          .filter((s) => s.user_id === user.id && s.status === 'active' && s.branch_id !== null)
          .map((s) => s.branch_id as string),
      ),
    ];
    const open = await Promise.all(
      candidates.map(async (id) => {
        if (id === branchId) return true;
        const { data } = await supabase.rpc('my_capabilities', { p_branch_id: id });
        return ((data ?? []) as string[]).includes('staff.manage');
      }),
    );
    staffBranchIds = candidates.filter((_, i) => open[i]);
  }

  // Each branch's team is its own. An admin of Hamburger only sees Food Thai Thai's people if
  // they manage Food Thai Thai too; the rows are dropped here so they never reach the browser.
  // Owners and rows with no branch work here as well, so they always stay.
  const roster = (staff ?? []).filter(
    (s) =>
      s.role === 'owner' ||
      s.branch_id === null ||
      s.branch_id === branchId ||
      staffBranchIds.includes(s.branch_id),
  );

  return (
    <StaffView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      branchName={branch.name}
      initialStaff={roster}
      branches={branches ?? []}
      viewerIsOwner={viewerIsOwner}
      viewerRestaurantWide={viewerRestaurantWide}
      viewerIsPlatformAdmin={platformAdmin}
      viewerUserId={user.id}
      staffBranchIds={staffBranchIds}
    />
  );
}
