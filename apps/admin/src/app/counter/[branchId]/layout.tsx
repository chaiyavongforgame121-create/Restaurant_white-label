import { getTranslations } from 'next-intl/server';
import { getMyStaffAccessRows } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { StaffAccessWatcher } from '@/components/staff-access-watcher';
import { SubscriptionEndedBanner, SubscriptionUnknownBanner } from '@/components/suspension-screen';

interface Props {
  params: Promise<{ branchId: string }>;
  children: React.ReactNode;
}

export default async function CounterLayout({ params, children }: Props) {
  const { branchId } = await params;
  // While the subscription has ended this layout stays up only as long as orders are still being
  // finished: Recent (which asks the same) is open until then, and the till and Tables send
  // everyone on themselves. A layout is not rendered again on a click between those pages, so each
  // page decides for itself; this is the full-load answer.
  const { supabase, user, branch, can, subscription } = await getBranchAccess(
    branchId,
    `/counter/${branchId}`,
    { whileLocked: 'ordersInProgress' },
  );
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
      {subscription.locked && <SubscriptionEndedBanner />}
      {!subscription.known && <SubscriptionUnknownBanner />}
      {children}
      {watcher}
    </>
  );
}
