'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import {
  acceptDispatch as acceptDispatchQuery,
  rejectDispatch as rejectDispatchQuery,
  progressDelivery as progressDeliveryQuery,
  markDeliveryArriving as markArrivingQuery,
  getActiveDelivery,
  type DeliveryStatus,
} from '@favornoms/database/queries';
import { useDriverSession } from './driver-session';

/**
 * A merged delivery + order + branch payload that the UI consumes.
 */
export interface ActiveDeliveryUI {
  id: string;
  orderId: string;
  orderNumber: string;
  status: DeliveryStatus;
  distanceKm: number;
  estimatedDurationMin: number;
  driverEarnings: number;
  /** Driver's net share of the order tip (deliveries.net_tip), stamped by dispatch-driver. Safe in any tips.mode. */
  netTip: number | null;
  /** Full order tip — present ONLY when platform tips.mode = 'transparent' (deliveries.tip_visible_total); null when hidden. */
  tipFullVisible: number | null;
  /** Stacked-order group (งานพ่วง): non-null when this job is one leg of a 2-order batch. */
  batchId: string | null;
  /** Drop-off order within the batch (1 = deliver first). */
  batchSeq: number | null;
  /** The other live leg of the batch (null once it's delivered/cancelled — the job then behaves like a single). */
  batchMate: ActiveDeliveryUI | null;
  branchName: string;
  branchAddress: string;
  customerName: string;
  customerAddress: string;
  customerPhone: string | null;
  itemsSummary: string;
  customerNotes: string | null;
  /** Free-form delivery instructions the customer entered (gate code, room, "leave at door"…). */
  dropoffNotes: string | null;
  /** Structured drop-off preference (delivery_address.dropoff_pref) — null on orders placed before it existed. */
  dropoffPref: 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other' | null;
  /** Customer's free-text spot, set iff dropoffPref === 'other'. */
  dropoffOther: string | null;
  gateCode: string | null;
  room: string | null;
  assignedAt: string | null;
  /** Stamped by accept_dispatch — null while the job is still just an offer. */
  acceptedAt: string | null;
  /** Server-side offer deadline (dispatch v2) — drives the countdown. */
  offerExpiresAt: string | null;
  /** Proof-of-pickup photo URL — required before the job can advance to picked_up. */
  pickupPhotoUrl: string | null;
  /** Proof-of-delivery photo URL — required before the job can be marked delivered. */
  podPhotoUrl: string | null;
  branchLat: number | null;
  branchLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
}

interface DeliveryContextValue {
  /** A new offer that has not been accepted yet. */
  offered: ActiveDeliveryUI | null;
  /** The delivery currently in flight (accepted, picked_up, in_transit). */
  active: ActiveDeliveryUI | null;
  accept: () => Promise<boolean>;
  reject: (reason?: 'timeout' | 'declined') => Promise<void>;
  progress: (next: DeliveryStatus) => Promise<void>;
  /** Persist "arrived at the customer" (sets arriving_at). */
  markArriving: () => Promise<void>;
  /** False while the realtime channel is down. Surfaced so the rider is told their
   *  phone is not currently receiving offers, rather than assuming it is quiet. */
  liveHealthy: boolean;
}

const DeliveryContext = React.createContext<DeliveryContextValue | null>(null);

function mapDeliveryToUI(row: Record<string, unknown>): ActiveDeliveryUI {
  const order = row.order as {
    id: string;
    order_number: string;
    customer_name: string;
    customer_phone: string | null;
    delivery_address: {
      line1?: string;
      notes?: string;
      dropoff_pref?: 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other';
      dropoff_other?: string;
      gate_code?: string;
      room?: string;
    } | null;
    customer_notes: string | null;
    order_items?: { item_name: string; quantity: number }[];
  };
  const branch = row.branch as {
    name: string;
    address: string;
    geo_lat?: number | null;
    geo_lng?: number | null;
  };

  const itemsSummary = (order.order_items ?? [])
    .map((i) => `${i.quantity}× ${i.item_name}`)
    .join(' · ');

  return {
    id: row.id as string,
    orderId: order.id,
    orderNumber: order.order_number,
    status: row.status as DeliveryStatus,
    distanceKm: (row.distance_km as number) ?? 0,
    estimatedDurationMin: (row.estimated_duration_min as number) ?? 0,
    driverEarnings: (row.driver_earnings as number) ?? 0,
    netTip: (row.net_tip as number | null) ?? null,
    tipFullVisible: (row.tip_visible_total as number | null) ?? null,
    batchId: (row.batch_id as string | null) ?? null,
    batchSeq: (row.batch_seq as number | null) ?? null,
    // One level deep only: the mate row never carries its own batch_mate.
    batchMate: row.batch_mate
      ? mapDeliveryToUI(row.batch_mate as Record<string, unknown>)
      : null,
    branchName: branch?.name ?? 'Restaurant',
    branchAddress: branch?.address ?? '',
    customerName: order.customer_name,
    customerAddress: order.delivery_address?.line1 ?? '',
    customerPhone: order.customer_phone ?? null,
    itemsSummary: itemsSummary || `${order.order_number}`,
    customerNotes: order.customer_notes ?? null,
    dropoffNotes: order.delivery_address?.notes ?? null,
    dropoffPref: order.delivery_address?.dropoff_pref ?? null,
    dropoffOther: order.delivery_address?.dropoff_other ?? null,
    gateCode: order.delivery_address?.gate_code ?? null,
    room: order.delivery_address?.room ?? null,
    assignedAt: (row.assigned_at as string | null) ?? null,
    acceptedAt: (row.accepted_at as string | null) ?? null,
    offerExpiresAt: (row.offer_expires_at as string | null) ?? null,
    pickupPhotoUrl: (row.pickup_photo_url as string | null) ?? null,
    podPhotoUrl: (row.pod_photo_url as string | null) ?? null,
    branchLat: branch?.geo_lat ?? null,
    branchLng: branch?.geo_lng ?? null,
    dropoffLat: (row.dropoff_lat as number | null) ?? null,
    dropoffLng: (row.dropoff_lng as number | null) ?? null,
  };
}

/**
 * The columns this app actually draws. An UPDATE that touches none of them is not worth a
 * reload — and that is the overwhelming majority of them, because set_driver_location
 * stamps the rider's own GPS fix onto their own delivery row every three seconds.
 */
const RENDERED_COLUMNS = [
  'status',
  'assigned_at',
  'accepted_at',
  'offer_expires_at',
  'pickup_photo_url',
  'pod_photo_url',
  'driver_earnings',
  'net_tip',
  'tip_visible_total',
  'batch_id',
  'batch_seq',
  'distance_km',
  'estimated_duration_min',
  'dropoff_lat',
  'dropoff_lng',
] as const;

function rowsAgree(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return RENDERED_COLUMNS.every((c) => Object.is(a[c] ?? null, b[c] ?? null));
}

/**
 * A refetch hands back a structurally identical job over and over. Keeping the object we
 * already have when nothing changed is what stops every consumer of this context — and
 * every effect downstream keyed on the job — from re-running for a job that did not move.
 */
function sameDelivery(a: ActiveDeliveryUI | null, b: ActiveDeliveryUI | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (!sameDelivery(a.batchMate, b.batchMate)) return false;
  return (Object.keys(a) as (keyof ActiveDeliveryUI)[]).every(
    (k) => k === 'batchMate' || a[k] === b[k],
  );
}

export function DeliveryProvider({ children }: { children: React.ReactNode }) {
  const { driver, refresh: refreshDriver } = useDriverSession();
  const driverId = driver.id;

  const [offered, setOffered] = React.useState<ActiveDeliveryUI | null>(null);
  const [active, setActive] = React.useState<ActiveDeliveryUI | null>(null);

  // What is on screen right now, readable from the realtime handler and from a refresh
  // that is already in flight without either of them being rebuilt when the job changes.
  const offeredRef = React.useRef<ActiveDeliveryUI | null>(null);
  const activeRef = React.useRef<ActiveDeliveryUI | null>(null);
  offeredRef.current = offered;
  activeRef.current = active;

  // The raw rows behind those two, so an incoming UPDATE can be compared column by column
  // against what was last read. At most two entries: a job and its batch mate.
  const rawRowsRef = React.useRef(new Map<string, Record<string, unknown>>());

  // Each refresh is several sequential round trips and one CTA tap fires three writes, so
  // several refreshes are routinely in flight together. Only the newest may set state —
  // otherwise the one that started first lands last and drags the stage card backwards.
  const seqRef = React.useRef(0);

  const refreshFromServer = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const seq = ++seqRef.current;

    let result: Awaited<ReturnType<typeof getActiveDelivery>>;
    try {
      result = await getActiveDelivery(supabase, driverId);
    } catch {
      // It now throws rather than passing a failed read off as "no job". Keep what is on
      // screen: useRealtime re-reads on reconnect, on focus and when the network returns.
      return;
    }
    if (seq !== seqRef.current) return;

    const row = result as unknown as Record<string, unknown> | null;
    if (!row) {
      if (!offeredRef.current && !activeRef.current) return;
      // Still not proof the rider is free: a null also means get_driver_order lost the race
      // against a reassign, and the read can simply be lagging. Clearing a live job on that
      // is how a delivery the rider is carrying vanishes from their screen mid-ride — the
      // same defect 1dc661d fixed on the customer's tracking page. Ask once more, cheaply,
      // and keep what we hold unless the server plainly says there is nothing.
      const { count, error } = await supabase
        .from('deliveries')
        .select('id', { head: true, count: 'exact' })
        .eq('driver_id', driverId)
        .in('status', ['assigned', 'picked_up', 'in_transit']);
      if (seq !== seqRef.current) return;
      if (error || (count ?? 0) > 0) return;
      rawRowsRef.current = new Map();
      setOffered(null);
      setActive(null);
      return;
    }

    const rawRows = new Map<string, Record<string, unknown>>();
    rawRows.set(row.id as string, row);
    const mate = row.batch_mate;
    if (mate && typeof mate === 'object') {
      const mateRow = mate as Record<string, unknown>;
      if (typeof mateRow.id === 'string') rawRows.set(mateRow.id, mateRow);
    }
    rawRowsRef.current = rawRows;

    const ui = mapDeliveryToUI(row);
    // accepted_at is the server-side acceptance signal (stamped by
    // accept_dispatch) — 'assigned' without it means a pending offer.
    if (ui.status === 'assigned' && !ui.acceptedAt) {
      setOffered((prev) => (sameDelivery(prev, ui) ? prev : ui));
      setActive(null);
    } else {
      setOffered(null);
      setActive((prev) => (sameDelivery(prev, ui) ? prev : ui));
    }
  }, [driverId]);

  // A rider's phone backgrounds constantly and rides through dead spots, so the socket
  // dropping is the normal case rather than the exception. useRealtime reconnects with
  // backoff and re-reads on every reconnect, on app focus and on network return —
  // without it a rider simply stopped being offered work with no sign anything was wrong.
  const { healthy: liveHealthy } = useRealtime({
    channel: `driver-deliveries-${driverId}`,
    tables: [{ table: 'deliveries', filter: `driver_id=eq.${driverId}` }],
    onChange: (payload) => {
      // The rider's own location ping writes to this very row every three seconds. Taking
      // a bare refetch on each of those meant reloading the whole screen twenty times a
      // minute for columns this app never draws. Anything else still resyncs in full.
      if (payload.eventType === 'UPDATE') {
        const next = payload.new as Record<string, unknown>;
        const id = typeof next.id === 'string' ? next.id : null;
        if (id) {
          const known = rawRowsRef.current.get(id);
          if (known && rowsAgree(known, next)) {
            // Hold the fresher row so the next comparison is against what the server has.
            rawRowsRef.current.set(id, next);
            return;
          }
        }
      }
      void refreshFromServer();
    },
    refetch: refreshFromServer,
    enabled: !!driverId,
  });

  const accept = React.useCallback(async (): Promise<boolean> => {
    if (!offered) return false;
    const supabase = getBrowserClient();
    const { error } = await acceptDispatchQuery(supabase, offered.id);
    if (error) {
      // Offer expired or was reassigned (no longer 'assigned' to this driver):
      // accept_dispatch raises 'forbidden'. Clear the stale offer and resync from
      // the server rather than silently leaving the driver with nothing.
      setOffered(null);
      void refreshFromServer();
      return false;
    }
    setActive({ ...offered, acceptedAt: new Date().toISOString() });
    setOffered(null);
    return true;
  }, [offered, refreshFromServer]);

  const reject = React.useCallback(
    async (reason: 'timeout' | 'declined' = 'declined') => {
      if (!offered) return;
      const supabase = getBrowserClient();
      await rejectDispatchQuery(supabase, offered.id, driverId, reason);
      setOffered(null);
      // A reject/timeout may have just stamped a penalty cooldown — re-read the
      // driver so Home reflects it (countdown + disabled toggles) immediately.
      void refreshDriver();
    },
    [offered, driverId, refreshDriver],
  );

  const progress = React.useCallback(
    async (next: DeliveryStatus) => {
      if (!active) return;
      const supabase = getBrowserClient();
      const { error } = await progressDeliveryQuery(supabase, active.id, next);
      if (error) {
        // The guarded progress_delivery RPC rejected the transition (illegal move,
        // concurrent cancel/reassign, RLS). Resync from the server instead of faking
        // an advance, and let the caller surface the failure (no false "completed").
        void refreshFromServer();
        throw new Error(error.message ?? 'progress_failed');
      }
      if (next === 'delivered') {
        setActive(null);
      } else {
        setActive({ ...active, status: next });
      }
    },
    [active, refreshFromServer],
  );

  const markArriving = React.useCallback(async () => {
    if (!active) return;
    const supabase = getBrowserClient();
    await markArrivingQuery(supabase, active.id);
  }, [active]);

  // A fresh object literal here re-rendered every useDelivery() consumer — the tab bar, Home
  // and the whole Active view — on any provider render at all, which multiplied the cost of
  // everything above.
  const value = React.useMemo(
    () => ({ offered, active, accept, reject, progress, markArriving, liveHealthy }),
    [offered, active, accept, reject, progress, markArriving, liveHealthy],
  );

  return <DeliveryContext.Provider value={value}>{children}</DeliveryContext.Provider>;
}

export function useDelivery() {
  const ctx = React.useContext(DeliveryContext);
  if (!ctx) throw new Error('useDelivery must be used inside <DeliveryProvider>');
  return ctx;
}
