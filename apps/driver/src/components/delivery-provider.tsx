'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import {
  acceptDispatch as acceptDispatchQuery,
  rejectDispatch as rejectDispatchQuery,
  progressDelivery as progressDeliveryQuery,
  markDeliveryArriving as markArrivingQuery,
  getActiveDelivery,
  holdsOpenDelivery,
  type DeliveryStatus,
} from '@favornoms/database/queries';
import {
  dispatchNotice,
  offerDeadlineMs,
  offerKey,
  offerSightings,
  offersOver,
  parseTimeMs,
  parseWorkerMessage,
  type DispatchNotice,
  type OfferSighting,
} from '@/lib/alerts';
import { reportLiveOffers } from '@/lib/offer-notifications';
import { useDriverSession } from './driver-session';

/**
 * A merged delivery + order + branch payload that the UI consumes.
 */
export interface ActiveDeliveryUI {
  id: string;
  /**
   * The rider's current turn at this delivery (delivery_assignments.id) — the chat thread's
   * key. Null while there is no open turn, which is a real state: the sheet must not mount
   * on a thread that does not exist rather than fall back to the delivery and reopen the
   * previous rider's conversation.
   */
  assignmentId: string | null;
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

/** A job that stopped being this rider's, and why — so the screen can say so. */
export interface EndedJobNotice {
  assignmentId: string;
  orderNumber: string;
  endKind: string | null;
  endReason: string | null;
}

/** How the server took the rider's answer to an offer. */
export type DispatchAnswer = { ok: true } | { ok: false; notice: DispatchNotice };

interface DeliveryContextValue {
  /** A new offer that has not been accepted yet. */
  offered: ActiveDeliveryUI | null;
  /**
   * When this phone treats `offered` as over (lib/alerts offerDeadlineMs): its server deadline,
   * never sooner than a few seconds after it appeared here. The sheet's countdown and the ring
   * both end at this one instant. Null without an offer.
   */
  offerDeadlineMs: number | null;
  /** An accept or a decline of `offered` is on its way to the server. */
  responding: boolean;
  /** The delivery currently in flight (accepted, picked_up, in_transit). */
  active: ActiveDeliveryUI | null;
  /**
   * True once the server has answered a read. Before that, "no offer, no job" only means nothing
   * has been read yet, which must not count as news (a job ringing as new) or as an all-clear
   * (offer notifications closed).
   */
  synced: boolean;
  /**
   * Answer the offer with this delivery id. Named rather than "the offer on screen": a sheet
   * still fading out after its own offer ended must not answer the next one, which may already
   * be on screen. An id that is not the offer on screen is a no-op.
   */
  accept: (offerId: string) => Promise<DispatchAnswer>;
  reject: (offerId: string, reason?: 'timeout' | 'declined') => Promise<DispatchAnswer>;
  progress: (next: DeliveryStatus) => Promise<void>;
  /** Persist "arrived at the customer" (sets arriving_at). */
  markArriving: () => Promise<void>;
  /**
   * Drop the job on screen without waiting for the server to say so. driver_cancel_delivery
   * nulls deliveries.driver_id and Realtime matches an UPDATE against the NEW row, so the
   * rider who just cancelled is the one party guaranteed NOT to receive the event.
   */
  clearActive: () => void;
  /** Set when a job was taken away from this rider. Null once dismissed. */
  lastEnded: EndedJobNotice | null;
  dismissLastEnded: () => void;
  /** False while the realtime channel is down. Surfaced so the rider is told their
   *  phone is not currently receiving offers, rather than assuming it is quiet. */
  liveHealthy: boolean;
}

const DeliveryContext = React.createContext<DeliveryContextValue | null>(null);

/** Endings worth interrupting the rider for: the ones somebody else caused. */
const ANNOUNCED_END_KINDS = [
  'order_cancelled',
  'reassigned_by_staff',
  'requeued_by_staff',
  'offer_expired',
];

/**
 * @param unnamedBranch Shown when the branch join comes back empty. Display text only, in the
 *   rider's language: nothing compares against it.
 */
function mapDeliveryToUI(row: Record<string, unknown>, unnamedBranch: string): ActiveDeliveryUI {
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
    assignmentId: ((row.assignment as { id?: string } | null)?.id ?? null) as string | null,
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
      ? mapDeliveryToUI(row.batch_mate as Record<string, unknown>, unnamedBranch)
      : null,
    branchName: branch?.name ?? unnamedBranch,
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
  const t = useTranslations('dispatch');
  // Read through a ref so a language change does not rebuild refreshFromServer, which the
  // realtime subscription is keyed on.
  const unnamedBranchRef = React.useRef(t('unnamedBranch'));
  unnamedBranchRef.current = t('unnamedBranch');

  const [offered, setOffered] = React.useState<ActiveDeliveryUI | null>(null);
  const [active, setActive] = React.useState<ActiveDeliveryUI | null>(null);
  const [lastEnded, setLastEnded] = React.useState<EndedJobNotice | null>(null);
  const [synced, setSynced] = React.useState(false);
  // The offer an accept or a decline is in flight for. Keyed by id so a reply that lands after
  // a newer offer arrived cannot mark that one as answered.
  const [respondingTo, setRespondingTo] = React.useState<string | null>(null);

  // An assignment row keeps being UPDATEd after it ends (status, earnings), so the notice is
  // announced once per turn rather than once per payload.
  const announcedEndRef = React.useRef(new Set<string>());

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

  // The first read that starts after the service worker said a push arrived. Once a read from
  // then on settles, the offers still live are reported to the worker even when nothing on
  // screen changed: that push may be for an offer this phone never showed, already gone, and its
  // notification should not stay up. Not after every read: one that started before the push
  // can land after its notification went up, and would close a live offer.
  const pushSeqRef = React.useRef<number | null>(null);
  const [pushReads, setPushReads] = React.useState(0);

  // The offer the server refused an accept for as expired (offerKey). Kept off the screen even if
  // a read still returns it before the expiry sweep has released it: it can only be refused again.
  // A re-offer of the same delivery has a new deadline, so a new key, and shows.
  const droppedOfferRef = React.useRef('');

  const refreshFromServer = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const seq = ++seqRef.current;
    // The server has answered for what is now on screen.
    const settle = () => {
      setSynced(true);
      if (pushSeqRef.current != null && seq >= pushSeqRef.current) {
        pushSeqRef.current = null;
        setPushReads((n) => n + 1);
      }
    };

    let result: Awaited<ReturnType<typeof getActiveDelivery>>;
    try {
      // An offer whose deadline has passed by the server's clock comes back as null here, so it
      // never rings or shows an Accept that can only be refused (queries/driver.ts).
      result = await getActiveDelivery(supabase, driverId);
    } catch {
      // It now throws rather than passing a failed read off as "no job". Keep what is on
      // screen: useRealtime re-reads on reconnect, on focus and when the network returns.
      return;
    }
    if (seq !== seqRef.current) return;

    const read = result as unknown as Record<string, unknown> | null;
    // The offer an accept was refused for as expired, read again before the sweep released it.
    const dropped =
      !!read &&
      read.status === 'assigned' &&
      !read.accepted_at &&
      droppedOfferRef.current !== '' &&
      offerKey({ id: read.id as string, offerExpiresAt: (read.offer_expires_at as string | null) ?? null }) ===
        droppedOfferRef.current;
    const row = dropped ? null : read;
    if (!row) {
      if (!offeredRef.current && !activeRef.current) {
        settle();
        return;
      }
      if (dropped) {
        // The rider holds nothing else while that offer is still theirs on the server.
        rawRowsRef.current = new Map();
        setOffered(null);
        setActive(null);
        settle();
        return;
      }
      // Still not proof the rider is free: a null also means get_driver_order lost the race
      // against a reassign, and the read can simply be lagging. Clearing a live job on that
      // is how a delivery the rider is carrying vanishes from their screen mid-ride — the
      // same defect 1dc661d fixed on the customer's tracking page. Ask once more, cheaply,
      // and keep what we hold unless the server plainly says there is nothing (an offer its
      // clock has ended counts as nothing).
      const holds = await holdsOpenDelivery(supabase, driverId);
      if (seq !== seqRef.current) return;
      if (holds !== false) return;
      rawRowsRef.current = new Map();
      setOffered(null);
      setActive(null);
      settle();
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

    const ui = mapDeliveryToUI(row, unnamedBranchRef.current);
    // accepted_at is the server-side acceptance signal (stamped by
    // accept_dispatch) — 'assigned' without it means a pending offer.
    if (ui.status === 'assigned' && !ui.acceptedAt) {
      setOffered((prev) => (sameDelivery(prev, ui) ? prev : ui));
      setActive(null);
    } else {
      setOffered(null);
      setActive((prev) => (sameDelivery(prev, ui) ? prev : ui));
    }
    settle();
  }, [driverId]);

  // A rider's phone backgrounds constantly and rides through dead spots, so the socket
  // dropping is the normal case rather than the exception. useRealtime reconnects with
  // backoff and re-reads on every reconnect, on app focus and on network return —
  // without it a rider simply stopped being offered work with no sign anything was wrong.
  const { healthy: liveHealthy } = useRealtime({
    channel: `driver-deliveries-${driverId}`,
    // Two tables, because deliveries alone cannot tell this rider they have lost a job.
    // Realtime evaluates the filter against the NEW row of an UPDATE, and every path that
    // takes a job away — the rider's own pre-pickup cancel, requeue_failed_delivery, a staff
    // reassign, reject_dispatch, expire_dispatch_offers — clears or moves driver_id, so the
    // row stops matching driver_id=eq.<rider> and no event is delivered at all. The
    // assignment row keeps driver_id for ever, so the turn ending is something this phone
    // can actually hear.
    tables: [
      { table: 'deliveries', filter: `driver_id=eq.${driverId}` },
      { table: 'delivery_assignments', filter: `driver_id=eq.${driverId}` },
    ],
    onChange: (payload, table) => {
      if (table === 'delivery_assignments') {
        if (payload.eventType === 'DELETE') return;
        const row = payload.new as {
          id?: string;
          delivery_id?: string;
          ended_at?: string | null;
          end_kind?: string | null;
          end_reason?: string | null;
        } | null;
        if (!row?.id) return;
        if (row.ended_at && !announcedEndRef.current.has(row.id)) {
          announcedEndRef.current.add(row.id);
          const held =
            activeRef.current?.id === row.delivery_id
              ? activeRef.current
              : offeredRef.current?.id === row.delivery_id
                ? offeredRef.current
                : null;
          // Only for a job that was on this phone, and only for the endings the rider did
          // not choose — a drop-off, a cancel or a decline they just made already has its
          // own screen, and being told about it reads as a second, different event.
          if (held && ANNOUNCED_END_KINDS.includes(row.end_kind ?? '')) {
            setLastEnded({
              assignmentId: row.id,
              orderNumber: held.orderNumber,
              endKind: row.end_kind ?? null,
              endReason: row.end_reason ?? null,
            });
          }
        }
        void refreshFromServer();
        return;
      }
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

  // When the offer on screen first appeared here, for its deadline. Reset with the offer (its
  // offerKey, the delivery and its deadline), so the same delivery offered again later starts a
  // fresh clock, as its sheet does.
  const offerShownRef = React.useRef<{ key: string; at: number } | null>(null);
  const offerDeadline = React.useMemo(() => {
    if (!offered) {
      offerShownRef.current = null;
      return null;
    }
    const key = offerKey(offered);
    if (offerShownRef.current?.key !== key) offerShownRef.current = { key, at: Date.now() };
    return offerDeadlineMs(parseTimeMs(offered.offerExpiresAt), offerShownRef.current.at);
  }, [offered]);

  // An answer the server refused because the offer expired: that offer is over whatever a read
  // still says, so it leaves the screen now, stops ringing, and never sends a timeout decline.
  const dropExpiredOffer = React.useCallback((offer: ActiveDeliveryUI) => {
    droppedOfferRef.current = offerKey(offer);
    setOffered((current) => (current?.id === offer.id ? null : current));
  }, []);

  // Both answers keep the offer on screen when the server does not take them, and ask the server
  // what the offer is now. The decline used to clear it whatever happened: a decline that never
  // arrived, or that the server refused, looked done on the phone while the server kept holding
  // the offer for this rider until it expired, and only then moved on to the next one. Now a
  // refusal for an offer that has moved on ('forbidden') ends with that read clearing it, and an
  // answer that got no reply leaves the offer, still the rider's, to be answered again.
  const accept = React.useCallback(async (offerId: string): Promise<DispatchAnswer> => {
    const offer = offeredRef.current;
    if (!offer || offer.id !== offerId) return { ok: false, notice: 'offerGone' };
    setRespondingTo(offer.id);
    const { refusal } = await acceptDispatchQuery(getBrowserClient(), offer.id);
    setRespondingTo((current) => (current === offer.id ? null : current));
    if (refusal) {
      const notice = dispatchNotice(refusal.reason, 'accept');
      if (notice === 'offerExpired') dropExpiredOffer(offer);
      void refreshFromServer();
      return { ok: false, notice };
    }
    setActive({ ...offer, acceptedAt: new Date().toISOString() });
    setOffered((current) => (current?.id === offer.id ? null : current));
    // A read that started before the accept would land showing the offer again, Accept button
    // and all. Starting a new one retires it (only the newest read may set state).
    void refreshFromServer();
    return { ok: true };
  }, [dropExpiredOffer, refreshFromServer]);

  const reject = React.useCallback(
    async (offerId: string, reason: 'timeout' | 'declined' = 'declined'): Promise<DispatchAnswer> => {
      const offer = offeredRef.current;
      // Nothing to decline: the offer this was about has already left the screen.
      if (!offer || offer.id !== offerId) return { ok: true };
      setRespondingTo(offer.id);
      const { refusal } = await rejectDispatchQuery(getBrowserClient(), offer.id, driverId, reason);
      setRespondingTo((current) => (current === offer.id ? null : current));
      if (refusal) {
        const notice = dispatchNotice(refusal.reason, 'decline');
        if (notice === 'offerExpired') dropExpiredOffer(offer);
        void refreshFromServer();
        return { ok: false, notice };
      }
      // Only the offer that was declined: one that arrived meanwhile is a new offer.
      setOffered((current) => (current?.id === offer.id ? null : current));
      // Same as accept: a read already in flight would bring the declined offer back. A fresh
      // one also picks up a new offer whose own read the old one may have been.
      void refreshFromServer();
      // A reject/timeout may have just stamped a penalty cooldown — re-read the
      // driver so Home reflects it (countdown + disabled toggles) immediately.
      void refreshDriver();
      return { ok: true };
    },
    [dropExpiredOffer, driverId, refreshDriver, refreshFromServer],
  );

  // The service worker says a push arrived. With the app open but its socket asleep (a phone
  // that dimmed, a dead spot) that push is the first this phone hears of a new offer: read now,
  // and the offer appearing on screen starts the ring.
  React.useEffect(() => {
    if (!driverId || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      if (parseWorkerMessage(event.data)?.type !== 'push') return;
      // refreshFromServer takes the next sequence number synchronously, so this is its read.
      pushSeqRef.current = seqRef.current + 1;
      void refreshFromServer();
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, [driverId, refreshFromServer]);

  // Offer notifications stay on the shade until touched. Once the server has answered, tell the
  // worker which offers are still this rider's so it can close the rest (expired, declined,
  // accepted, given to someone else), and which ones this phone saw end, so a push for one of
  // those that is still on its way is closed when it lands rather than buzzing the rider again.
  const liveOfferKey = synced
    ? offerSightings(offered)
        .map((s) => `${s.deliveryId}@${s.expiresAtMs ?? ''}`)
        .join(',')
    : null;
  const reportedOffersRef = React.useRef<OfferSighting[]>([]);
  React.useEffect(() => {
    if (liveOfferKey == null) return;
    const live = offerSightings(offeredRef.current);
    const over = offersOver(reportedOffersRef.current, live);
    reportedOffersRef.current = live;
    reportLiveOffers(
      live.map((s) => s.deliveryId),
      over,
    );
  }, [liveOfferKey, pushReads]);

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

  const clearActive = React.useCallback(() => {
    // Invalidate anything already in flight as well: a refresh that started before the
    // cancel would otherwise land afterwards and put the job straight back on screen.
    seqRef.current += 1;
    rawRowsRef.current = new Map();
    setOffered(null);
    setActive(null);
  }, []);

  const dismissLastEnded = React.useCallback(() => setLastEnded(null), []);

  // A fresh object literal here re-rendered every useDelivery() consumer — the tab bar, Home
  // and the whole Active view — on any provider render at all, which multiplied the cost of
  // everything above.
  const responding = !!offered && respondingTo === offered.id;
  const value = React.useMemo(
    () => ({
      offered,
      offerDeadlineMs: offerDeadline,
      responding,
      active,
      synced,
      accept,
      reject,
      progress,
      markArriving,
      clearActive,
      lastEnded,
      dismissLastEnded,
      liveHealthy,
    }),
    [
      offered,
      offerDeadline,
      responding,
      active,
      synced,
      accept,
      reject,
      progress,
      markArriving,
      clearActive,
      lastEnded,
      dismissLastEnded,
      liveHealthy,
    ],
  );

  return <DeliveryContext.Provider value={value}>{children}</DeliveryContext.Provider>;
}

export function useDelivery() {
  const ctx = React.useContext(DeliveryContext);
  if (!ctx) throw new Error('useDelivery must be used inside <DeliveryProvider>');
  return ctx;
}
