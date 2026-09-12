'use client';

import * as React from 'react';
import Link from 'next/link';
import { Bike, Crosshair, Phone, Receipt, RotateCcw, Search, UserRound, XCircle } from 'lucide-react';
import {
  MapView,
  hasMapboxToken,
  loadMapboxGl,
  type MapboxMap,
  type MapboxMarker,
} from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import {
  LIVE_DELIVERY_STATUSES,
  listBranchRiders,
  listLiveDeliveries,
  type BranchRider,
  type LiveDelivery,
} from '@favornoms/database/queries';
import { formatPhone } from '@favornoms/shared';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';
import { AssignRiderSheet } from './assign-rider-sheet';
import {
  ageLabel,
  boardCounts,
  canAssign,
  canCancelDelivery,
  canFindRider,
  describeDelivery,
  describeDispatchFailure,
  dropoffPosition,
  formatCountdown,
  lastEndedWithReason,
  mergeRefetch,
  offerOpen,
  partitionStale,
  readableRpcError,
  riderMapPosition,
  riderPinState,
  riderPosition,
  type DeliveryAssignmentRef,
  type DispatchFailure,
} from './live-ops-model';

// Live delivery operations board. Two questions, one screen: where is every order that has
// not been handed over yet, and where are the riders who could take it. The map draws both;
// the list beside it is where a stuck one gets unstuck.

/**
 * What a merchant is actually cancelling for. This screen used to send the literal string
 * 'Cancelled from Live deliveries' with no input at all, and the diner's tracking page — which
 * has always rendered orders.cancellation_reason — showed its generic fallback instead.
 */
const CANCEL_REASONS = [
  'Kitchen cannot make it',
  'Customer asked to cancel',
  'No rider available',
  'Duplicate order',
];
const CANCEL_OTHER = 'Other';
/** Matches the server-side cap in cancel_order. */
const CANCEL_REASON_MAX = 300;

/** No assignments yet is the common case; one shared array keeps the card memo-stable. */
const NO_ASSIGNMENTS: DeliveryAssignmentRef[] = [];

/** Riders idle on the map. A rider on a job is drawn by the job, in the shop's blue. */
const RIDER_COLOR: Record<'available' | 'stale', string> = {
  available: '#23C16B',
  stale: '#9A6206',
};

function markerEl(
  emoji: string,
  bg: string,
  size: number,
  opts: { label?: string; title?: string; onClick?: () => void } = {},
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:2px;';
  if (opts.title) wrap.title = opts.title;
  if (opts.onClick) {
    wrap.style.cursor = 'pointer';
    wrap.addEventListener('click', opts.onClick);
  }
  const puck = document.createElement('div');
  puck.style.cssText = `width:${size}px;height:${size}px;border-radius:50%;background:${bg};display:grid;place-items:center;font-size:${Math.round(size * 0.5)}px;box-shadow:0 2px 6px rgba(0,0,0,0.3);border:2px solid #fff;`;
  puck.textContent = emoji;
  wrap.appendChild(puck);
  if (opts.label) {
    const tag = document.createElement('div');
    tag.style.cssText =
      'max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:1px 5px;border-radius:999px;background:rgba(255,255,255,.92);color:#111;font:600 10px/1.4 system-ui,sans-serif;box-shadow:0 1px 3px rgba(0,0,0,.25);';
    tag.textContent = opts.label;
    wrap.appendChild(tag);
  }
  return wrap;
}

/** Ticks once a second, and only where a second actually matters. */
function OfferCountdown({ expiresAt }: { expiresAt: string }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(left) || left <= 0) return <>Offer expired — returning to the pool</>;
  return <>Expires in {formatCountdown(left)}</>;
}

/** Ages, overdue flags and staleness only need to move at walking pace. */
function useNow(intervalMs: number): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

// Re-dispatch a failed delivery straight from the live board (was only on the Orders page).
function RedispatchButton({
  deliveryId,
  onDone,
}: {
  deliveryId: string;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setErr(null);
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('requeue_failed_delivery', {
      p_delivery_id: deliveryId,
    } as never);
    setBusy(false);
    if (error) {
      setErr(readableRpcError(error.message));
      return;
    }
    void onDone();
  };
  return (
    <>
      <Button
        variant="soft"
        size="sm"
        onClick={run}
        loading={busy}
        leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
      >
        Re-dispatch
      </Button>
      {err && (
        <p role="alert" className="mt-1 basis-full text-xs text-danger">
          {err}
        </p>
      )}
    </>
  );
}

/**
 * Advance a self-delivered order. Only rendered when the branch delivers with its own
 * staff — in platform mode the rider moves the delivery from their phone, and a second
 * button that bypasses the photo and sequence rules in progress_delivery would be a way
 * to mark food delivered that never left.
 */
function SelfDeliveryButtons({
  deliveryId,
  status,
  onDone,
}: {
  deliveryId: string;
  status: string;
  onDone: () => void | Promise<void>;
}) {
  const [busy, setBusy] = React.useState<string | null>(null);
  const [err, setErr] = React.useState<string | null>(null);

  const advance = async (to: 'picked_up' | 'delivered') => {
    setBusy(to);
    setErr(null);
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('advance_self_delivery', {
      p_delivery_id: deliveryId,
      p_to: to,
    } as never);
    setBusy(null);
    if (error) {
      setErr(readableRpcError(error.message));
      return;
    }
    void onDone();
  };

  const next =
    status === 'picked_up'
      ? ({ to: 'delivered', label: 'Mark delivered' } as const)
      : (['assigned', 'dispatching', 'pending'] as string[]).includes(status)
        ? ({ to: 'picked_up', label: 'Out for delivery' } as const)
        : null;

  if (!next) return null;

  return (
    <>
      <Button
        variant="soft"
        size="sm"
        onClick={() => void advance(next.to)}
        loading={busy === next.to}
      >
        {next.label}
      </Button>
      {err && (
        <p role="alert" className="mt-1 basis-full text-xs text-danger">
          {err}
        </p>
      )}
    </>
  );
}

function StatPill({ label, value, tone }: { label: string; value: number; tone?: string }) {
  if (value === 0) return null;
  return (
    <span
      className={`rounded-full px-2.5 py-1 text-xs font-semibold ${tone ?? 'bg-muted text-muted-foreground'}`}
    >
      {value} {label}
    </span>
  );
}

interface CardProps {
  d: LiveDelivery;
  /** This delivery's rider turns, oldest first. Carries the reasons the delivery row lost. */
  assignments: readonly DeliveryAssignmentRef[];
  branchId: string;
  nowMs: number;
  selfDelivery: boolean;
  canCancel: boolean;
  selected: boolean;
  riderName: string | null;
  busy: boolean;
  error: { message: string; canReset: boolean } | null;
  onSelect: () => void;
  onAssign: () => void;
  onCancel: () => void;
  onFindRider: (reset: boolean) => void;
  onRefresh: () => void | Promise<void>;
}

function DeliveryCard({
  d,
  assignments,
  branchId,
  nowMs,
  selfDelivery,
  canCancel,
  selected,
  riderName,
  busy,
  error,
  onSelect,
  onAssign,
  onCancel,
  onFindRider,
  onRefresh,
}: CardProps) {
  const info = describeDelivery(d, nowMs, selfDelivery, assignments);
  const walked = lastEndedWithReason(assignments);
  // Suppressed when describeDelivery already put those exact words on the card — the point is
  // that the reason is visible once, not that it is visible twice.
  const lastRiderNote =
    walked && walked.end_reason && !info.detail.includes(walked.end_reason)
      ? walked.end_reason
      : null;
  const order = d.order;
  const addr = order?.delivery_address ?? null;
  const addressLine = [addr?.line1, addr?.city].filter(Boolean).join(', ');
  // The realtime payload carries no embeds, so a freshly offered row knows its driver_id
  // before it knows the name; the polled rider list fills that second-long gap.
  const rider = d.driver?.full_name ?? riderName;
  const withRider = d.status === 'picked_up' || d.status === 'in_transit';

  return (
    <li
      onClick={onSelect}
      className={`cursor-pointer rounded-xl border p-3 transition-colors ${
        selected ? 'border-primary ring-2 ring-primary' : 'border-border/60 hover:border-border'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-1.5">
        <p className="font-mono text-xs text-muted-foreground">{order?.order_number ?? '—'}</p>
        <div className="flex items-center gap-1.5">
          {info.overdue && <Badge variant="danger">Waiting {ageLabel(d.created_at, nowMs)}</Badge>}
          <Badge variant={info.variant}>{info.label}</Badge>
        </div>
      </div>

      <p className="mt-1 text-sm font-medium">{order?.customer_name ?? 'Customer'}</p>

      {order?.customer_phone && (
        <a
          href={`tel:${order.customer_phone}`}
          onClick={(e) => e.stopPropagation()}
          className="focus-ring mt-0.5 inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <Phone className="h-3 w-3" /> {formatPhone(order.customer_phone)}
        </a>
      )}

      {addressLine && <p className="mt-0.5 text-xs text-muted-foreground">{addressLine}</p>}
      {addr?.notes && <p className="text-xs italic text-muted-foreground">“{addr.notes}”</p>}

      <p className="mt-1.5 text-xs text-muted-foreground">
        {offerOpen(d, nowMs) && d.offer_expires_at ? (
          <OfferCountdown expiresAt={d.offer_expires_at} />
        ) : (
          info.detail
        )}
      </p>

      <p className="mt-0.5 text-xs text-muted-foreground">
        {rider ? (
          <>
            <UserRound className="mr-1 inline h-3 w-3" />
            {rider}
            {d.driver?.vehicle_type ? ` · ${d.driver.vehicle_type}` : ''}
            {d.driver?.phone && (
              <>
                {' · '}
                <a
                  href={`tel:${d.driver.phone}`}
                  onClick={(e) => e.stopPropagation()}
                  className="focus-ring text-primary hover:underline"
                >
                  Call rider
                </a>
              </>
            )}
          </>
        ) : (
          'No rider yet'
        )}
        {' · placed '}
        {ageLabel(d.created_at, nowMs)} ago
      </p>

      {lastRiderNote && <p className="mt-1 text-xs text-danger">Last rider: “{lastRiderNote}”</p>}

      <div className="mt-2 flex flex-wrap items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
        {canFindRider(d, selfDelivery) && (
          <Button
            variant="soft"
            size="sm"
            loading={busy}
            onClick={() => onFindRider(false)}
            leftIcon={<Search className="h-3.5 w-3.5" />}
          >
            Find a rider
          </Button>
        )}
        {canAssign(d, selfDelivery) && (
          <Button
            variant="outline"
            size="sm"
            onClick={onAssign}
            leftIcon={<UserRound className="h-3.5 w-3.5" />}
          >
            {d.driver_id ? 'Reassign' : 'Assign to a rider'}
          </Button>
        )}
        {d.status === 'failed' && !selfDelivery && (
          <RedispatchButton deliveryId={d.id} onDone={onRefresh} />
        )}
        {selfDelivery && (
          <SelfDeliveryButtons deliveryId={d.id} status={d.status} onDone={onRefresh} />
        )}
        {canCancel && canCancelDelivery(d) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onCancel}
            leftIcon={<XCircle className="h-3.5 w-3.5" />}
          >
            Cancel order
          </Button>
        )}
        {order && (
          <Link
            href={`/b/${branchId}/orders?q=${encodeURIComponent(order.order_number)}`}
            className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
          >
            <Receipt className="h-3.5 w-3.5" /> View order
          </Link>
        )}
      </div>

      {/* The food has already left the shop: cancelling here would leave a rider holding a
          meal nobody is paying for, so point at where the refund actually lives. */}
      {withRider && canCancel && (
        <p className="mt-1.5 text-xs text-muted-foreground">
          Food is with the rider — refund it from Orders if it cannot be delivered.
        </p>
      )}

      {error && (
        <div role="alert" className="mt-2 rounded-lg bg-danger/10 px-2.5 py-1.5 text-xs text-danger">
          {error.message}
          {error.canReset && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onFindRider(true);
              }}
              className="focus-ring ml-2 rounded font-semibold underline"
            >
              Retry from scratch
            </button>
          )}
        </div>
      )}
    </li>
  );
}

export function LiveOpsView({
  branchId,
  branchName,
  branchLat,
  branchLng,
  selfDelivery = false,
  canCancel = false,
  maxGpsAgeMin = 5,
}: {
  branchId: string;
  branchName: string;
  branchLat: number | null;
  branchLng: number | null;
  /** branches.settings.delivery_mode === 'self' — the restaurant's own staff deliver,
   *  so there is no rider app moving the delivery along and no position to plot. */
  selfDelivery?: boolean;
  /** orders.cancel — the only clean exit for a delivery nobody will ever take. */
  canCancel?: boolean;
  /** branches.settings.dispatch_max_gps_age_min: past this, dispatch stops trusting a fix. */
  maxGpsAgeMin?: number;
}) {
  const [deliveries, setDeliveries] = React.useState<LiveDelivery[]>([]);
  const [riders, setRiders] = React.useState<BranchRider[]>([]);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [ridersError, setRidersError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [showStale, setShowStale] = React.useState(false);
  const [assignFor, setAssignFor] = React.useState<LiveDelivery | null>(null);
  const [cancelFor, setCancelFor] = React.useState<LiveDelivery | null>(null);
  const [cancelBusy, setCancelBusy] = React.useState(false);
  const [cancelError, setCancelError] = React.useState<string | null>(null);
  const [cancelReason, setCancelReason] = React.useState<string | null>(null);
  const [cancelOther, setCancelOther] = React.useState('');
  const [assignments, setAssignments] = React.useState<DeliveryAssignmentRef[]>([]);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [actionError, setActionError] = React.useState<{
    id: string;
    message: string;
    canReset: boolean;
  } | null>(null);
  const [mapReady, setMapReady] = React.useState(false);

  const mapRef = React.useRef<MapboxMap | null>(null);
  const markersRef = React.useRef<Map<string, MapboxMarker>>(new Map());
  const refreshSeq = React.useRef(0);
  const didFitRef = React.useRef(false);

  const nowMs = useNow(20_000);

  /**
   * The rider turns behind the rows on the board. Read separately because
   * LIVE_DELIVERY_SELECT is shared with other callers, and because these rows change on their
   * own schedule — one per re-dispatch — while the delivery row they belong to does not.
   */
  const loadAssignments = React.useCallback(async (deliveryIds: string[]) => {
    if (deliveryIds.length === 0) {
      setAssignments([]);
      return;
    }
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('delivery_assignments')
      .select('id, delivery_id, seq, driver_id, status, end_kind, end_reason, offered_at, ended_at')
      .in('delivery_id', deliveryIds)
      .order('seq', { ascending: true });
    // Best-effort: losing the reasons costs a line of explanation, never the board.
    if (data) setAssignments(data as unknown as DeliveryAssignmentRef[]);
  }, []);

  const refresh = React.useCallback(async () => {
    const seq = ++refreshSeq.current;
    const supabase = getBrowserClient();
    try {
      const rows = await listLiveDeliveries(supabase, branchId);
      // Several of these can be in flight at once; an older snapshot resolving last would
      // pop rows back on to the board that a newer one had already retired.
      if (seq !== refreshSeq.current) return;
      setLoadError(null);
      setDeliveries((prev) => mergeRefetch(prev, rows, false));
      void loadAssignments(rows.map((r) => r.id));
    } catch (e) {
      if (seq !== refreshSeq.current) return;
      // A read that failed used to arrive as an empty array and render as "no active
      // deliveries" — the one answer this screen must never give when it does not know.
      setLoadError(e instanceof Error ? e.message.replace(/^\w+_read_failed:\s*/, '') : String(e));
    } finally {
      if (seq === refreshSeq.current) setLoaded(true);
    }
  }, [branchId, loadAssignments]);

  const loadRiders = React.useCallback(async () => {
    if (selfDelivery) return;
    const supabase = getBrowserClient();
    try {
      setRiders(await listBranchRiders(supabase, branchId));
      setRidersError(null);
    } catch (e) {
      setRidersError(
        e instanceof Error ? e.message.replace(/^\w+_read_failed:\s*/, '') : String(e),
      );
    }
  }, [branchId, selfDelivery]);

  // drivers is deliberately not in the realtime publication (the row carries an encrypted
  // national id and bank details) and current_location is a PostGIS geography PostgREST
  // hands back as WKB, so rider positions are polled through the RPC rather than streamed.
  // 15 s sits inside the rider app's 60 s idle GPS cadence.
  React.useEffect(() => {
    if (selfDelivery) return;
    void loadRiders();
    const id = setInterval(() => void loadRiders(), 15_000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void loadRiders();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [loadRiders, selfDelivery]);

  const deliveriesRef = React.useRef<LiveDelivery[]>([]);
  deliveriesRef.current = deliveries;

  // useRealtime refetches on connect, on reconnect, on tab focus and on network return,
  // so the board recovers by itself instead of silently freezing on a dropped socket.
  const { healthy: liveHealthy } = useRealtime({
    channel: `live-ops:${branchId}`,
    tables: [
      { table: 'deliveries', filter: `branch_id=eq.${branchId}` },
      { table: 'delivery_assignments', filter: `branch_id=eq.${branchId}` },
    ],
    refetch: refresh,
    // Merge the payload into the row already held instead of refetching the board. A rider
    // pushes GPS every 3 seconds while on a delivery and it lands on deliveries.driver_lat /
    // driver_lng, so leaving this out meant a full refetch several times a second, each one
    // replacing the whole list and re-running the marker sync.
    onChange: (payload, table) => {
      if (table === 'delivery_assignments') {
        // A turn opening or ending is what carries the rider's own words onto the board.
        void loadAssignments(deliveriesRef.current.map((d) => d.id));
        return;
      }
      if (payload.eventType === 'DELETE') {
        const goneId = (payload.old as { id?: string } | null)?.id;
        if (goneId) setDeliveries((prev) => prev.filter((d) => d.id !== goneId));
        return;
      }
      const row = payload.new as (Partial<LiveDelivery> & { id?: string }) | null;
      if (!row?.id) return;
      const held = deliveriesRef.current.find((d) => d.id === row.id);
      const stillLive =
        row.status == null || (LIVE_DELIVERY_STATUSES as readonly string[]).includes(row.status);
      if (!held) {
        // A row we have never seen arrives without its order and rider embeds, and the
        // order's own status is what decides whether it belongs on the board at all.
        if (stillLive) void refresh();
        return;
      }
      if (row.driver_id !== undefined && row.driver_id !== held.driver_id) {
        // The rider changed and the payload carries no name or phone for the new one.
        void refresh();
        void loadRiders();
        return;
      }
      setDeliveries((prev) =>
        stillLive
          ? prev.map((d) =>
              d.id === row.id
                ? ({ ...d, ...row, order: d.order, driver: d.driver } as LiveDelivery)
                : d,
            )
          : prev.filter((d) => d.id !== row.id),
      );
    },
  });

  const { live, stale } = React.useMemo(
    () => partitionStale(deliveries, nowMs),
    [deliveries, nowMs],
  );
  const counts = React.useMemo(() => boardCounts(live), [live]);
  const ridersReady = React.useMemo(
    () => riders.filter((r) => riderPinState(r, nowMs, maxGpsAgeMin) === 'available').length,
    [riders, nowMs, maxGpsAgeMin],
  );

  // Refs so the map callbacks never close over a stale snapshot.
  const liveRef = React.useRef<LiveDelivery[]>([]);
  liveRef.current = live;
  const ridersRef = React.useRef<BranchRider[]>([]);
  ridersRef.current = riders;

  const fitAll = React.useCallback(async () => {
    const map = mapRef.current;
    if (!map) return;
    const mapboxgl = await loadMapboxGl();
    const bounds = new mapboxgl.LngLatBounds();
    let n = 0;
    if (branchLat != null && branchLng != null) {
      bounds.extend([branchLng, branchLat]);
      n += 1;
    }
    for (const d of liveRef.current) {
      const drop = dropoffPosition(d);
      if (drop) {
        bounds.extend([drop.lng, drop.lat]);
        n += 1;
      }
      const pos = riderPosition(d);
      if (pos) {
        bounds.extend([pos.lng, pos.lat]);
        n += 1;
      }
    }
    for (const r of ridersRef.current) {
      if (r.active_delivery_id) continue;
      const p = riderMapPosition(r);
      if (p) {
        bounds.extend([p.lng, p.lat]);
        n += 1;
      }
    }
    // One point is not a bounding box; fitBounds on it zooms to street level on the shop.
    if (n < 2) return;
    map.fitBounds(bounds, { padding: 56, maxZoom: 14, duration: 600 });
  }, [branchLat, branchLng]);

  // Keep the markers in step with the board. Stale rows are left off on purpose: a June
  // test order's drop-off in another country dragged the viewport away from today's work.
  React.useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    void (async () => {
      const mapboxgl = await loadMapboxGl();
      const seen = new Set<string>();

      // Move the marker that is already there. Rebuilding it on every GPS ping made the
      // whole map flicker several times a second. Anything baked into the marker's element
      // — its colour, its label — therefore belongs in the key, or a rider whose GPS went
      // stale would keep a green puck until they went offline.
      const place = (key: string, lng: number, lat: number, build: () => MapboxMarker) => {
        seen.add(key);
        const existing = markersRef.current.get(key);
        if (existing) existing.setLngLat([lng, lat]);
        else markersRef.current.set(key, build());
      };

      for (const d of liveRef.current) {
        const drop = dropoffPosition(d);
        if (drop) {
          place(
            `drop:${d.id}`,
            drop.lng,
            drop.lat,
            () =>
              new mapboxgl.Marker({
                element: markerEl('🏠', '#2D936C', 24, {
                  label: d.order?.order_number.slice(-6) ?? '',
                  title: `${d.order?.order_number ?? ''} · ${d.order?.customer_name ?? 'Customer'}`,
                  onClick: () => setSelectedId(d.id),
                }),
              })
                .setLngLat([drop.lng, drop.lat])
                .addTo(map),
          );
        }
        // riderPosition returns null unless a rider actually holds this job: rejection,
        // offer expiry and cancellation all clear driver_id but leave the last driver_lat /
        // driver_lng behind, which used to draw a scooter nobody was riding.
        const pos = riderPosition(d);
        if (pos) {
          place(
            `job:${d.id}:${d.driver_id}`,
            pos.lng,
            pos.lat,
            () =>
              new mapboxgl.Marker({
                element: markerEl('🛵', '#1F6FEB', 30, {
                  label: d.driver?.full_name.split(' ')[0] ?? 'Rider',
                  title: `${d.driver?.full_name ?? 'Rider'} · ${d.order?.order_number ?? ''}`,
                  onClick: () => setSelectedId(d.id),
                }),
              })
                .setLngLat([pos.lng, pos.lat])
                .addTo(map),
          );
        }
      }

      for (const r of ridersRef.current) {
        const state = riderPinState(r, nowMs, maxGpsAgeMin);
        // A rider on a job is already drawn by that job; offline riders have nothing to say.
        if (state === 'busy' || state === 'offline') continue;
        const p = riderMapPosition(r);
        if (!p) continue;
        place(
          `rider:${r.driver_id}:${state}`,
          p.lng,
          p.lat,
          () =>
            new mapboxgl.Marker({
              element: markerEl('🛵', RIDER_COLOR[state], 26, {
                label: r.full_name.split(' ')[0] ?? '',
                title: `${r.full_name} · GPS ${ageLabel(r.location_updated_at, nowMs)} old`,
              }),
            })
              .setLngLat([p.lng, p.lat])
              .addTo(map),
        );
      }

      for (const [key, marker] of markersRef.current) {
        if (key === 'branch' || seen.has(key)) continue;
        marker.remove();
        markersRef.current.delete(key);
      }

      // One automatic fit, the first time there is anything to fit to. After that the
      // viewport belongs to whoever is looking at it.
      if (!didFitRef.current && seen.size > 0) {
        didFitRef.current = true;
        void fitAll();
      }
    })();
  }, [live, riders, mapReady, nowMs, maxGpsAgeMin, fitAll]);

  const handleMapReady = React.useCallback(
    (map: MapboxMap) => {
      mapRef.current = map;
      void (async () => {
        const mapboxgl = await loadMapboxGl();
        if (branchLat != null && branchLng != null) {
          markersRef.current.set(
            'branch',
            new mapboxgl.Marker({ element: markerEl('🏪', '#FF6B35', 34, { title: branchName }) })
              .setLngLat([branchLng, branchLat])
              .addTo(map),
          );
        }
        setMapReady(true);
      })();
    },
    [branchLat, branchLng, branchName],
  );

  // Clicking a card walks the map to it, which is the only way to tell a dozen identical
  // house pins apart.
  const selectCard = React.useCallback((d: LiveDelivery) => {
    setSelectedId(d.id);
    const map = mapRef.current;
    if (!map) return;
    const target = riderPosition(d) ?? dropoffPosition(d);
    if (!target) return;
    map.easeTo({
      center: [target.lng, target.lat],
      zoom: Math.max(map.getZoom(), 13),
      duration: 500,
    });
  }, []);

  const findRider = React.useCallback(
    async (d: LiveDelivery, reset: boolean) => {
      setBusyId(d.id);
      setActionError(null);
      const supabase = getBrowserClient();
      const { error } = await supabase.functions.invoke('dispatch-driver', {
        body: reset ? { delivery_id: d.id, reset: true } : { delivery_id: d.id },
      });
      setBusyId(null);
      if (error) {
        // supabase-js hides the response body behind error.context. A 503 from
        // dispatch-driver carries which gate emptied the candidate list, and that reason is
        // the only useful thing here — "no rider found" alone had merchants chasing riders
        // who were online the whole time.
        let reason = '';
        try {
          const ctx = (error as unknown as { context?: Response }).context;
          if (ctx && typeof ctx.json === 'function') {
            reason = describeDispatchFailure((await ctx.json()) as DispatchFailure);
          }
        } catch {
          /* body unreadable — fall through to the bare error */
        }
        setActionError({
          id: d.id,
          message: reason || error.message,
          canReset: !reset && /Tried every rider/i.test(reason),
        });
        return;
      }
      await refresh();
    },
    [refresh],
  );

  // "Other" is only a reason once somebody types one, and this string is what the diner reads
  // on their tracking page — so an empty one is a cancellation nobody can explain to them.
  const finalCancelReason =
    cancelReason === CANCEL_OTHER ? cancelOther.trim() : (cancelReason ?? '');

  const doCancel = React.useCallback(async () => {
    const d = cancelFor;
    if (!d?.order || !finalCancelReason) return;
    setCancelBusy(true);
    setCancelError(null);
    const supabase = getBrowserClient();
    // cancel_order only ever touched orders; the delivery follows because of the
    // orders_cancel_syncs_delivery trigger that ships with this screen.
    const { error } = await supabase.rpc('cancel_order', {
      p_order_id: d.order.id,
      p_reason: finalCancelReason,
    });
    setCancelBusy(false);
    if (error) {
      setCancelError(readableRpcError(error.message));
      return;
    }
    setCancelFor(null);
    await refresh();
  }, [cancelFor, finalCancelReason, refresh]);

  const assignmentsByDelivery = React.useMemo(() => {
    const m = new Map<string, DeliveryAssignmentRef[]>();
    for (const a of assignments) {
      const list = m.get(a.delivery_id);
      if (list) list.push(a);
      else m.set(a.delivery_id, [a]);
    }
    return m;
  }, [assignments]);

  const riderNameById = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const r of riders) m.set(r.driver_id, r.full_name);
    return m;
  }, [riders]);

  const hasMap = hasMapboxToken() && branchLat != null && branchLng != null;

  const cardFor = (d: LiveDelivery) => (
    <DeliveryCard
      key={d.id}
      d={d}
      assignments={assignmentsByDelivery.get(d.id) ?? NO_ASSIGNMENTS}
      branchId={branchId}
      nowMs={nowMs}
      selfDelivery={selfDelivery}
      canCancel={canCancel}
      selected={selectedId === d.id}
      riderName={d.driver_id ? (riderNameById.get(d.driver_id) ?? null) : null}
      busy={busyId === d.id}
      error={actionError?.id === d.id ? actionError : null}
      onSelect={() => selectCard(d)}
      onAssign={() => setAssignFor(d)}
      onCancel={() => {
        setCancelError(null);
        setCancelReason(null);
        setCancelOther('');
        setCancelFor(d);
      }}
      onFindRider={(reset) => void findRider(d, reset)}
      onRefresh={refresh}
    />
  );

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="flex items-center gap-2 font-display text-3xl font-bold">
          <Bike className="h-7 w-7 text-primary" /> Live deliveries
        </h1>
        <p className="mt-1 font-medium text-foreground">
          Where your riders and live orders are right now.
        </p>
        <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
          {selfDelivery
            ? `Every delivery order at ${branchName} from the moment it is placed until it is handed over. You deliver these yourself — move each one along with the buttons on its card.`
            : `Every delivery order at ${branchName} from the moment it is placed until it is handed over: where the rider is, how long until it arrives, and who is waiting. Riders approved here also appear on the map whenever they are online, even between jobs.`}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <StatPill label="waiting on the kitchen" value={counts.waitingKitchen} />
          <StatPill
            label="finding a rider"
            value={counts.findingRider}
            tone="bg-warning/15 text-warning"
          />
          <StatPill label="offered" value={counts.offered} tone="bg-warning/15 text-warning" />
          <StatPill label="accepted" value={counts.accepted} tone="bg-info/15 text-info" />
          <StatPill label="on the way" value={counts.onTheWay} tone="bg-primary/15 text-primary" />
          <StatPill label="failed" value={counts.failed} tone="bg-danger/15 text-danger" />
          {!selfDelivery && (
            <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold text-muted-foreground">
              {ridersReady} of {riders.length} approved riders ready
            </span>
          )}
          <span
            role="status"
            className={`rounded-full px-2.5 py-1 text-xs font-semibold ${
              liveHealthy ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning'
            }`}
          >
            {liveHealthy ? 'Live' : 'Reconnecting…'}
          </span>
        </div>
      </header>

      <div className="grid gap-4 px-2 lg:grid-cols-5 lg:px-0">
        <Card className="overflow-hidden p-0 lg:col-span-3">
          {hasMap ? (
            <>
              <div className="relative">
                <MapView
                  center={{ lat: branchLat as number, lng: branchLng as number }}
                  zoom={12.5}
                  className="h-[480px] w-full"
                  onMapReady={handleMapReady}
                />
                <div className="absolute right-3 top-3">
                  <Button
                    variant="glass"
                    size="sm"
                    onClick={() => void fitAll()}
                    leftIcon={<Crosshair className="h-3.5 w-3.5" />}
                  >
                    Fit all
                  </Button>
                </div>
              </div>
              <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border/60 px-3 py-2 text-xs text-muted-foreground">
                <span>🏪 your shop</span>
                <span>🏠 drop-off</span>
                <span>🛵 blue: on a job</span>
                <span>🛵 green: ready</span>
                <span>🛵 amber: online, GPS stale</span>
              </p>
            </>
          ) : (
            <div className="grid h-[480px] place-items-center px-6 text-center text-sm text-muted-foreground">
              {!hasMapboxToken() ? (
                <p>Map unavailable — set NEXT_PUBLIC_MAPBOX_TOKEN.</p>
              ) : (
                <p>
                  This branch has no map pin yet, so there is nothing to draw riders against.{' '}
                  <Link
                    href={`/b/${branchId}/branch`}
                    className="font-medium text-primary hover:underline"
                  >
                    Set it in Branch settings
                  </Link>
                  .
                </p>
              )}
            </div>
          )}
        </Card>

        <Card className="max-h-[560px] overflow-y-auto p-4 lg:col-span-2">
          <h2 className="font-display text-base font-semibold">In flight</h2>

          {loadError && (
            <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              Could not load deliveries: {loadError}
            </p>
          )}
          {ridersError && (
            <p role="alert" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
              Could not load riders: {ridersError}
            </p>
          )}

          {!loadError && loaded && live.length === 0 && (
            <EmptyState
              icon={<Bike className="h-7 w-7" />}
              title="No deliveries in flight"
              description={
                selfDelivery
                  ? `A card appears the moment someone places a delivery order at ${branchName}, and stays until you mark it delivered.`
                  : `A card appears the moment someone places a delivery order at ${branchName}, and stays until the food is handed over. ${ridersReady} of ${riders.length} approved riders are ready right now${
                      riders.length === 0 ? ' — no rider is approved for this branch yet' : ''
                    }.`
              }
              action={
                !selfDelivery && (riders.length === 0 || ridersReady === 0) ? (
                  <Link
                    href={`/b/${branchId}/drivers`}
                    className="focus-ring inline-flex items-center gap-1 rounded-xl bg-primary px-3 py-2 text-sm font-medium text-primary-foreground"
                  >
                    <Bike className="h-4 w-4" /> Open Drivers
                  </Link>
                ) : undefined
              }
            />
          )}

          <ul className="mt-2 space-y-2">{live.map(cardFor)}</ul>

          {/* Rows nobody has touched in half a day. They are still real and still the
              merchant's to clear, but they are not what "live" means — parking them here is
              what turned "19 in flight" back into a number that means something. */}
          {stale.length > 0 && (
            <div className="mt-4 border-t border-border/60 pt-3">
              <button
                type="button"
                onClick={() => setShowStale((s) => !s)}
                className="focus-ring flex w-full items-center justify-between rounded-lg px-1 py-1 text-left text-sm font-medium"
              >
                <span>
                  {stale.length} stalled {stale.length === 1 ? 'order' : 'orders'}
                </span>
                <span className="text-xs text-muted-foreground">{showStale ? 'Hide' : 'Show'}</span>
              </button>
              <p className="px-1 pb-2 text-xs text-muted-foreground">
                Older than 12 hours and still waiting. Kept off the map — cancel or assign them
                from here.
              </p>
              {showStale && <ul className="space-y-2">{stale.map(cardFor)}</ul>}
            </div>
          )}

          {!selfDelivery && riders.length > 0 && (
            <div className="mt-4 border-t border-border/60 pt-3">
              <h3 className="text-sm font-medium">Riders</h3>
              <ul className="mt-1.5 space-y-1">
                {riders.map((r) => {
                  const state = riderPinState(r, nowMs, maxGpsAgeMin);
                  return (
                    <li key={r.driver_id} className="flex items-center gap-2 text-xs">
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${
                          state === 'available'
                            ? 'bg-success'
                            : state === 'busy'
                              ? 'bg-info'
                              : state === 'stale'
                                ? 'bg-warning'
                                : 'bg-muted-foreground/50'
                        }`}
                      />
                      <span className="min-w-0 flex-1 truncate font-medium">{r.full_name}</span>
                      <span className="shrink-0 text-muted-foreground">
                        {state === 'busy'
                          ? 'On a job'
                          : state === 'offline'
                            ? 'Offline'
                            : `GPS ${ageLabel(r.location_updated_at, nowMs)}`}
                        {r.battery_level != null ? ` · ${r.battery_level}%` : ''}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </Card>
      </div>

      <AssignRiderSheet
        open={assignFor !== null}
        onClose={() => setAssignFor(null)}
        deliveryId={assignFor?.id ?? null}
        orderNumber={assignFor?.order?.order_number ?? null}
        riders={riders}
        maxGpsAgeMin={maxGpsAgeMin}
        onAssigned={async () => {
          await refresh();
          await loadRiders();
        }}
      />

      {cancelFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => !cancelBusy && setCancelFor(null)}
        >
          <Card className="w-full max-w-sm space-y-3 p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-display text-lg font-semibold">
              Cancel {cancelFor.order?.order_number ?? 'this order'}?
            </h2>
            <p className="text-sm text-muted-foreground">
              This cancels the order, restores stock and takes the delivery off the board. It
              can&apos;t be undone.
            </p>
            <fieldset className="space-y-1.5">
              <legend className="text-sm font-medium">
                Why? The customer sees this on their order page.
              </legend>
              {[...CANCEL_REASONS, CANCEL_OTHER].map((r) => (
                <label key={r} className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="cancel-reason"
                    checked={cancelReason === r}
                    onChange={() => setCancelReason(r)}
                  />
                  {r}
                </label>
              ))}
            </fieldset>
            {cancelReason === CANCEL_OTHER && (
              <div>
                <label htmlFor="cancel-other" className="sr-only">
                  What happened
                </label>
                <textarea
                  id="cancel-other"
                  value={cancelOther}
                  onChange={(e) => setCancelOther(e.target.value)}
                  rows={3}
                  maxLength={CANCEL_REASON_MAX}
                  placeholder="Tell the customer what happened"
                  className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none"
                />
                <p className="mt-1 text-right text-[11px] text-muted-foreground">
                  {cancelOther.trim().length}/{CANCEL_REASON_MAX}
                </p>
              </div>
            )}
            {cancelError && (
              <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                {cancelError}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCancelFor(null)} disabled={cancelBusy}>
                Keep order
              </Button>
              <Button
                variant="danger"
                onClick={() => void doCancel()}
                loading={cancelBusy}
                disabled={!finalCancelReason}
              >
                Yes, cancel
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
