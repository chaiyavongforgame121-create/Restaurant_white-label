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

export default async function KitchenLayout({ params, children }: Props) {
  const { branchId } = await params;
  // While the subscription has ended the board stays open only for the orders already placed
  // (owner decision 2026-10-27); once none is left, the next load sends everyone on.
  const { supabase, user, branch, can, subscription } = await getBranchAccess(
    branchId,
    `/kitchen/${branchId}`,
    { whileLocked: 'ordersInProgress' },
  );
  // What this render was decided from, so the watcher can tell when the restaurant changes it.
  const myRows = await getMyStaffAccessRows(supabase, user.id, branch.restaurant_id);
  // On the denied screen too, so someone given the kitchen role while waiting there gets the board.
  // Scoped to this branch: the board keeps its fullscreen and sound when the owner changes what
  // the same person does at another branch.
  const watcher = (
    <StaffAccessWatcher
      userId={user.id}
      restaurantId={branch.restaurant_id}
      branchId={branchId}
      initialRows={myRows}
    />
  );

  if (!can('kitchen.access')) {
    const t = await getTranslations('kitchen');
    return (
      <>
        <AccessDenied
          title={t('accessDenied.title')}
          reason={t('accessDenied.reason', { branch: branch.name })}
        />
        {watcher}
      </>
    );
  }

  // Force the light, warm "Sunset" kitchen aesthetic regardless of the app theme.
  // The board paints its own full-height surface; this cream backstop matches it
  // so any overscroll/safe-area shows the same warm tone (never the dark app shell).
  return (
    <div className="min-h-dynamic-screen" style={{ background: '#FCF3EA' }}>
      {subscription.locked && <SubscriptionEndedBanner />}
      {!subscription.known && <SubscriptionUnknownBanner />}
      {children}
      {watcher}
    </div>
  );
}
