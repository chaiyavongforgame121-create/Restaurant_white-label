import { getTranslations } from 'next-intl/server';
import { getMyStaffAccessRows } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { StaffAccessWatcher } from '@/components/staff-access-watcher';

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function CounterLayout({ params, children }: Props) {
  const { branchId } = await params;
  const { supabase, user, branch, can } = await getBranchAccess(branchId, `/counter/${branchId}`);
  // What this render was decided from, so the watcher can tell when the restaurant changes it.
  const myRows = await getMyStaffAccessRows(supabase, user.id, branch.restaurant_id);
  // On the denied screen too: a suspended cashier waiting there is let back in the moment the
  // owner reactivates them. Scoped to this branch, so a change to the same person's row at
  // another branch does not reload a till mid-sale here.
  const watcher = (
    <StaffAccessWatcher
      userId={user.id}
      restaurantId={branch.restaurant_id}
      branchId={branchId}
      initialRows={myRows}
    />
  );

  if (!can('counter.access')) {
    const t = await getTranslations('counter');
    return (
      <>
        <AccessDenied
          title={t('access.title')}
          reason={t('access.reason', { branch: branch.name })}
        />
        {watcher}
      </>
    );
  }

  return (
    <>
      {children}
      {watcher}
    </>
  );
}
