import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
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
  if (!can('delivery.manage')) {
    return (
      <AccessDenied
        title="No delivery access"
        reason={`Your role cannot manage deliveries at ${branch.name}.`}
      />
    );
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
  );
}
