import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { hasRunsOut, resolveDeliveryGate } from '@/lib/delivery-gate';
import { AccessDenied } from '@/components/access-denied';
import { DeliveryLocked, DeliveryStoppedNotice } from '@/components/delivery-locked';
import { LiveOpsView } from './_components/live-ops-view';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function DeliveriesPage({ params }: Props) {
  const { branchId } = await params;
  // The sidebar hides this entry without delivery.manage, but the URL is guessable and the
  // RLS policy on deliveries is plain branch membership — a cashier who typed it got the
  // whole board, riders' phone numbers included. Gate it like the Drivers page does.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/deliveries`);
  const t = await getTranslations('deliveries');
  if (!can('delivery.manage')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  // The board itself never asked whether this branch sells delivery — only who may manage
  // it — so a branch without the add-on showed a working live-ops screen. Delivery is per
  // branch now, so this is the branch's own answer and the merchant is told which branch.
  //
  // Runs already out are the exception, for the same reason dispatch-driver dispatches them
  // whatever the switch says: a delivery that exists is finished (the rule in
  // supabase/functions/_shared/entitlements.ts), and a rider halfway to a customer must not be
  // left with nobody watching. The board stays open, with a line saying why, until the last
  // one lands. hasRunsOut is the same question the sidebar entry and the dashboard ask, so
  // the link to this screen exists exactly while the screen does.
  const [gate, runsOut] = await Promise.all([
    resolveDeliveryGate(supabase, branchId),
    hasRunsOut(supabase, branchId),
  ]);
  if (!gate.delivers && !runsOut) {
    return <DeliveryLocked branchId={branchId} branchName={branch.name} gate={gate} />;
  }

  // getBranchAccess already read the branch for its name and access check; this second read
  // is the map pin and the delivery settings. maybeSingle, not single: a branch the reader
  // cannot see should not throw past the gate that just let them in.
  const { data: detail } = await supabase
    .from('branches')
    .select('geo_lat, geo_lng, settings')
    .eq('id', branchId)
    .maybeSingle();
  const settings = (detail?.settings ?? {}) as Record<string, unknown>;

  return (
    <>
      {!gate.delivers && (
        <DeliveryStoppedNotice
          branchName={branch.name}
          planHref={gate.planHref}
          body={t('notOffered.stillInFlight')}
        />
      )}
      <LiveOpsView
        branchId={branchId}
        branchName={branch.name}
        branchLat={detail?.geo_lat ?? null}
        branchLng={detail?.geo_lng ?? null}
        selfDelivery={settings.delivery_mode === 'self'}
        canCancel={can('orders.cancel')}
        // The same cutoff dispatch uses to decide a rider's last fix is too old to trust, so
        // "GPS stale" on this board means exactly "auto-dispatch will skip this rider".
        maxGpsAgeMin={Math.max(1, Number(settings.dispatch_max_gps_age_min) || 5)}
      />
    </>
  );
}
