'use client';

import * as React from 'react';
import { Bike, RotateCcw } from 'lucide-react';
import {
  MapView,
  hasMapboxToken,
  loadMapboxGl,
  type MapboxMap,
  type MapboxMarker,
} from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

// Live delivery operations board: every in-flight delivery for the branch on
// one map (driver puck + dropoff pin) with a realtime status list beside it.

interface LiveDelivery {
  id: string;
  status: string;
  driver_id: string | null;
  driver_lat: number | null;
  driver_lng: number | null;
  dropoff_lat: number | null;
  dropoff_lng: number | null;
  current_eta_min: number | null;
  arriving_at: string | null;
  offer_expires_at: string | null;
  accepted_at: string | null;
  order: { order_number: string; customer_name: string | null } | null;
}

const LIVE_STATUSES = ['pending', 'dispatching', 'assigned', 'picked_up', 'in_transit', 'failed'];

const STATUS_BADGE: Record<string, { label: string; variant: string }> = {
  pending: { label: 'Waiting kitchen', variant: 'muted' },
  dispatching: { label: 'Finding driver', variant: 'warning' },
  assigned: { label: 'Offered', variant: 'warning' },
  picked_up: { label: 'Picked up', variant: 'default' },
  in_transit: { label: 'On the way', variant: 'default' },
  failed: { label: 'Failed', variant: 'danger' },
};

// Re-dispatch a failed delivery straight from the live board (was only on the Orders page).
function RedispatchButton({ deliveryId, onDone }: { deliveryId: string; onDone: () => void | Promise<void> }) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('requeue_failed_delivery', { p_delivery_id: deliveryId } as never);
    setBusy(false);
    if (error) {
      setErr(error.message);
      return;
    }
    void onDone();
  };
  return (
    <div className="mt-2">
      <Button variant="soft" size="sm" onClick={run} loading={busy} leftIcon={<RotateCcw className="h-3.5 w-3.5" />}>
        Re-dispatch
      </Button>
      {err && <p className="mt-1 text-xs text-destructive">{err}</p>}
    </div>
  );
}

function markerEl(emoji: string, bg: string, size = 30): HTMLDivElement {
  const el = document.createElement('div');
  el.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${bg};display:grid;place-items:center;font-size:${Math.round(size * 0.5)}px;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:2px solid #fff;`;
  el.textContent = emoji;
  return el;
}

export function LiveOpsView({
  branchId,
  branchName,
  branchLat,
  branchLng,
}: {
  branchId: string;
  branchName: string;
  branchLat: number | null;
  branchLng: number | null;
}) {
  const [deliveries, setDeliveries] = React.useState<LiveDelivery[]>([]);
  const mapRef = React.useRef<MapboxMap | null>(null);
  const markersRef = React.useRef<Map<string, MapboxMarker>>(new Map());

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('deliveries')
      .select(
        'id, status, driver_id, driver_lat, driver_lng, dropoff_lat, dropoff_lng, current_eta_min, arriving_at, offer_expires_at, accepted_at, order:orders(order_number, customer_name)',
      )
      .eq('branch_id', branchId)
      .in('status', LIVE_STATUSES)
      .order('created_at', { ascending: false })
      .limit(50);
    setDeliveries(
      ((data ?? []) as unknown as Array<Omit<LiveDelivery, 'order'> & { order: unknown }>).map((d) => ({
        ...d,
        order: (Array.isArray(d.order) ? d.order[0] : d.order) as LiveDelivery['order'],
      })),
    );
  }, [branchId]);

  React.useEffect(() => {
    void refresh();
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`live-ops:${branchId}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deliveries', filter: `branch_id=eq.${branchId}` },
        () => void refresh(),
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [branchId, refresh]);

  // Sync driver/dropoff markers with the latest snapshot.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    void (async () => {
      const mapboxgl = await loadMapboxGl();
      const seen = new Set<string>();
      for (const d of deliveries) {
        if (d.driver_lat != null && d.driver_lng != null) {
          const key = `driver:${d.id}`;
          seen.add(key);
          const existing = markersRef.current.get(key);
          if (existing) {
            existing.setLngLat([d.driver_lng, d.driver_lat]);
          } else {
            markersRef.current.set(
              key,
              new mapboxgl.Marker({ element: markerEl('🛵', '#1F6FEB') })
                .setLngLat([d.driver_lng, d.driver_lat])
                .addTo(map),
            );
          }
        }
        if (d.dropoff_lat != null && d.dropoff_lng != null) {
          const key = `drop:${d.id}`;
          seen.add(key);
          if (!markersRef.current.has(key)) {
            markersRef.current.set(
              key,
              new mapboxgl.Marker({ element: markerEl('🏠', '#2D936C', 24) })
                .setLngLat([d.dropoff_lng, d.dropoff_lat])
                .addTo(map),
            );
          }
        }
      }
      for (const [key, marker] of markersRef.current) {
        if (!seen.has(key)) {
          marker.remove();
          markersRef.current.delete(key);
        }
      }
    })();
  }, [deliveries]);

  const handleMapReady = React.useCallback(
    (map: MapboxMap) => {
      mapRef.current = map;
      void (async () => {
        const mapboxgl = await loadMapboxGl();
        if (branchLat != null && branchLng != null) {
          new mapboxgl.Marker({ element: markerEl('🏪', '#FF6B35', 34) })
            .setLngLat([branchLng, branchLat])
            .addTo(map);
        }
      })();
    },
    [branchLat, branchLng],
  );

  const hasMap = hasMapboxToken() && branchLat != null && branchLng != null;

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Bike className="h-7 w-7 text-primary" /> Live deliveries
        </h1>
        <p className="mt-1 text-muted-foreground">
          {branchName} · {deliveries.length} in flight · realtime
        </p>
      </header>

      <div className="grid gap-4 px-2 lg:grid-cols-5 lg:px-0">
        <Card className="overflow-hidden p-0 lg:col-span-3">
          {hasMap ? (
            <MapView
              center={{ lat: branchLat as number, lng: branchLng as number }}
              zoom={12.5}
              className="h-[480px] w-full"
              onMapReady={handleMapReady}
            />
          ) : (
            <div className="grid h-[480px] place-items-center text-center text-sm text-muted-foreground">
              <p>
                Map unavailable —{' '}
                {!hasMapboxToken() ? 'set NEXT_PUBLIC_MAPBOX_TOKEN' : 'branch has no coordinates'}.
              </p>
            </div>
          )}
        </Card>

        <Card className="max-h-[480px] overflow-y-auto p-4 lg:col-span-2">
          <h2 className="font-display text-base font-semibold">In flight</h2>
          {deliveries.length === 0 && (
            <p className="mt-4 text-sm text-muted-foreground">No active deliveries right now.</p>
          )}
          <ul className="mt-2 space-y-2">
            {deliveries.map((d) => {
              const badge = STATUS_BADGE[d.status] ?? { label: d.status, variant: 'muted' };
              return (
                <li key={d.id} className="rounded-xl border border-border/60 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-mono text-xs text-muted-foreground">
                      {d.order?.order_number ?? '—'}
                    </p>
                    <Badge variant={badge.variant as never}>{badge.label}</Badge>
                  </div>
                  <p className="mt-1 text-sm font-medium">{d.order?.customer_name ?? 'Customer'}</p>
                  <p className="text-xs text-muted-foreground">
                    {d.arriving_at
                      ? 'Arriving now'
                      : d.current_eta_min != null
                        ? `ETA ${d.current_eta_min} min`
                        : d.status === 'assigned' && !d.accepted_at && d.offer_expires_at
                          ? `Offer expires ${new Date(d.offer_expires_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                          : ''}
                  </p>
                  {d.status === 'failed' && <RedispatchButton deliveryId={d.id} onDone={refresh} />}
                </li>
              );
            })}
          </ul>
        </Card>
      </div>
    </div>
  );
}
