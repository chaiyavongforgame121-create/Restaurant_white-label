'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bike, ChefHat, CheckCircle2, ChevronLeft, MapPin, Phone, Receipt } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import {
  DeliveryMap,
  fetchRoute,
  fixAgeSeconds,
  formatFixAge,
  hasMapboxToken,
  isFixStale,
  type LatLng,
} from '@favornoms/maps';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { DeliveryChat } from './delivery-chat';
import { OrderActions, type ExistingRating } from './order-actions';

// Pickup and dine-in orders jump ready → completed; showing them a bike stage
// they can never reach reads like the order is stuck. Delivery keeps all 5.
const DELIVERY_STEPS = [
  { key: 'confirmed', icon: CheckCircle2 },
  { key: 'preparing', icon: ChefHat },
  { key: 'ready', icon: Receipt },
  { key: 'out_for_delivery', icon: Bike },
  { key: 'completed', icon: MapPin },
] as const;
const NON_DELIVERY_STEPS = [
  { key: 'confirmed', icon: CheckCircle2 },
  { key: 'preparing', icon: ChefHat },
  { key: 'ready', icon: Receipt },
  { key: 'completed', icon: MapPin },
] as const;

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  channel: string;
  /**
   * Why the order was cancelled — the merchant's or the diner's own words. decide_payment_proof
   * was the only function that ever wrote it, so every staff, kitchen and customer cancellation
   * fell through to the generic line below; cancel_order writes it now (20260908111000).
   */
  cancellation_reason?: string | null;
  /** A QR-transfer order the merchant has not confirmed payment for. It is deliberately not
   *  on the kitchen board yet, which is what makes self-cancel safe here. */
  awaiting_payment?: boolean | null;
  total: number | string;
  customer_name?: string | null;
  customer_phone?: string | null;
  created_at: string;
  order_items: Array<{ item_name: string; quantity: number }>;
  payments?: Array<{
    id?: string;
    method: string;
    status: string;
    proof_image_url?: string | null;
    gateway_metadata?: Record<string, unknown> | null;
  }>;
  deliveries: Array<{
    id: string;
    status: string;
    driver_id: string | null;
    distance_km: number | null;
    estimated_duration_min: number | null;
    accepted_at?: string | null;
    driver_lat?: number | null;
    driver_lng?: number | null;
    /** When that pin was last reported. A frozen pin and a parked rider look identical
     *  without it, and the rider's app stops reporting the moment it is backgrounded. */
    driver_location_updated_at?: string | null;
    current_eta_min?: number | null;
    arriving_at?: string | null;
    dropoff_lat?: number | null;
    dropoff_lng?: number | null;
    /** Stacked order (งานพ่วง): 2 = the driver makes one other drop-off first. */
    batch_seq?: number | null;
  }>;
};

/**
 * One rider's turn at this delivery. deliveries has a UNIQUE index on order_id, so the row
 * itself is reused by every re-dispatch — the thread the diner is looking at belongs to the
 * turn, not to the delivery, or a replacement rider inherits the last one's conversation.
 */
type DeliveryAssignment = {
  id: string;
  seq: number;
  ended_at: string | null;
};

export interface QrTransfer {
  image_url?: string;
  account_name?: string;
  instructions?: string;
}

interface Props {
  initialOrder: OrderRow;
  branchId: string;
  branchLocation?: { lat: number; lng: number } | null;
  /** branches.settings.qr_transfer. The code is shown HERE, not at checkout, so the diner
   *  pays against an order that already exists and has a number to quote. */
  qrTransfer?: QrTransfer | null;
}

/**
 * PostgREST returns `null` — not `[]` — for an embed with no related rows, and this page
 * reads `order.deliveries[0]` directly.
 *
 * The server page normalises the FIRST render, but `reload()` and the realtime merge write
 * straight into state, so an order with no delivery row yet (every pickup, dine-in and
 * QR order, and every delivery order before dispatch creates the row) put `null` back and
 * the next render threw "Cannot read properties of null (reading '0')". Normalising on
 * every path into state is the only place this can be fixed once.
 */
function asArray<T>(v: T[] | T | null | undefined): T[] {
  return Array.isArray(v) ? v : v ? [v] : [];
}

type DeliveryRow = OrderRow['deliveries'][number];

/**
 * What this page draws, and nothing else.
 *
 * A postgres_changes payload carries the deliveries row as the TABLE has it — the rider's
 * earnings, their tip split, the dispatch history, the pickup photo, the failure reason —
 * and the old merge copied all of it into this component's state, where it stayed for the
 * whole delivery. None of it is the diner's business. (The row still reaches the browser:
 * Postgres column privileges are per-ROLE, and staff and riders read those same columns as
 * `authenticated`. See the migration header for what a real fix costs.)
 */
const TRACKED_DELIVERY_FIELDS = [
  'id',
  'status',
  'driver_id',
  'distance_km',
  'estimated_duration_min',
  'accepted_at',
  'driver_lat',
  'driver_lng',
  'driver_location_updated_at',
  'current_eta_min',
  'arriving_at',
  'dropoff_lat',
  'dropoff_lng',
  'batch_seq',
] as const;

function pickTrackedFields(row: Record<string, unknown>): Partial<DeliveryRow> {
  const out: Record<string, unknown> = {};
  for (const key of TRACKED_DELIVERY_FIELDS) {
    if (key in row) out[key] = row[key];
  }
  return out as Partial<DeliveryRow>;
}

export function OrderTracking({ initialOrder, branchId, branchLocation, qrTransfer }: Props) {
  const t = useTranslations('tracking');
  const router = useRouter();
  const pathname = usePathname();
  const [order, setOrder] = React.useState<OrderRow>(() => ({
    ...initialOrder,
    order_items: initialOrder.order_items ?? [],
    payments: asArray(initialOrder.payments),
    deliveries: asArray(initialOrder.deliveries),
  }));

  const [assignments, setAssignments] = React.useState<DeliveryAssignment[]>([]);

  // Read separately from the order: getOrderByNumber's embed is shared with the receipt and
  // the server render, and this list changes on its own schedule (every re-dispatch).
  const loadAssignments = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('delivery_assignments')
      .select('id, seq, ended_at')
      .eq('order_id', order.id)
      .order('seq', { ascending: true });
    if (data) setAssignments(data as unknown as DeliveryAssignment[]);
  }, [order.id]);

  React.useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  // Re-read the order from the server. Used on (re)connect and when the tab wakes:
  // a diner watching this page leaves it backgrounded for the whole delivery, by which
  // time the socket is usually gone and the progress bar was silently frozen.
  const reload = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('orders')
      .select(
        'id, status, deliveries(id, status, driver_id, distance_km, estimated_duration_min, assigned_at, accepted_at, picked_up_at, delivered_at, driver_lat, driver_lng, driver_location_updated_at, current_eta_min, arriving_at, dropoff_lat, dropoff_lng, batch_seq)',
      )
      .eq('id', order.id)
      .maybeSingle();
    if (!data) return;
    setOrder((curr) => {
      const next = { ...curr, ...(data as unknown as Partial<OrderRow>) };
      const incoming = asArray(next.deliveries);
      const existing = asArray(curr.deliveries);
      // A refetch must never REMOVE the driver. useRealtime calls this on connect,
      // reconnect, tab focus and network resume, and any of those can land while the
      // embedded deliveries read comes back empty — a moment of RLS/replication lag is
      // enough. Overwriting with [] made the driver card appear the instant the rider
      // accepted and then vanish a beat later, which is exactly the reported flicker.
      next.deliveries = incoming.length === 0 && existing.length > 0 ? existing : incoming;
      return next;
    });
  }, [order.id]);

  const { healthy: liveHealthy } = useRealtime({
    channel: `order:${order.id}`,
    tables: [
      { table: 'orders', event: 'UPDATE', filter: `id=eq.${order.id}` },
      { table: 'deliveries', filter: `order_id=eq.${order.id}` },
      { table: 'delivery_assignments', filter: `order_id=eq.${order.id}` },
    ],
    refetch: () => {
      void loadAssignments();
      return reload();
    },
    onChange: (payload, table) => {
      if (table === 'delivery_assignments') {
        // A turn opening or closing swaps which thread the Chat button addresses, so it has
        // to be a re-read rather than a merge into whatever is held.
        void loadAssignments();
        return;
      }
      if (table === 'deliveries') {
        setOrder((curr) => {
          if (!payload.new) return curr;
          const incoming = pickTrackedFields(payload.new as Record<string, unknown>);
          const existing = asArray(curr.deliveries)[0];
          // Merge rather than replace. A postgres_changes payload carries the row as the
          // TABLE has it, not as this page selected it, so swapping the object wholesale
          // can drop fields the UI depends on — driver_id among them, which is what
          // decides whether the driver card renders at all.
          return {
            ...curr,
            deliveries: [{ ...(existing ?? {}), ...incoming } as DeliveryRow],
          };
        });
        return;
      }
      setOrder((curr) => ({ ...curr, ...(payload.new as Partial<OrderRow>) }));
    },
  });

  const steps = order.channel === 'delivery' ? DELIVERY_STEPS : NON_DELIVERY_STEPS;

  // One DB status reads three different ways. A seated diner is served at the
  // table — never "collected", and certainly never "delivered". qr_ordering is
  // dine-in with a QR menu, so it takes the same wording.
  const atTable = order.channel === 'dine_in' || order.channel === 'qr_ordering';
  const statusLabel = (key: string) => {
    let k = key;
    if (atTable && key === 'ready') k = 'readyDineIn';
    else if (atTable && key === 'completed') k = 'completedDineIn';
    else if (order.channel === 'pickup' && key === 'completed') k = 'completedPickup';
    return t(('statuses.' + k) as never);
  };

  // An order can be rated exactly once (unique(order_id) on order_ratings), so
  // the CTA must know whether one already exists — `undefined` until answered.
  const [rating, setRating] = React.useState<ExistingRating | null | undefined>(undefined);

  React.useEffect(() => {
    if (order.status !== 'completed') {
      // Nothing to rate yet; skip the round-trip. The effect re-runs when the
      // status flips to completed (realtime included).
      setRating(null);
      return;
    }
    let cancelled = false;
    const supabase = getBrowserClient();
    void supabase
      .from('order_ratings')
      .select('food_stars, delivery_stars, comment, driver_comment')
      .eq('order_id', order.id)
      .maybeSingle()
      .then(({ data, error }) => {
        if (cancelled) return;
        // A failed lookup can't prove a rating is absent — stay `undefined` so
        // we don't re-ask (the insert would only bounce off the unique index).
        setRating(error ? undefined : (data as ExistingRating | null));
      });
    return () => {
      cancelled = true;
    };
  }, [order.id, order.status]);

  // Find current step by status
  const statusIndex = React.useMemo(() => {
    // 'delivered' is a terminal delivery status with no distinct step — map it to the final
    // 'completed' step so a just-delivered order doesn't snap the bar back to step 1.
    const key = order.status === 'delivered' ? 'completed' : order.status;
    const idx = steps.findIndex((s) => s.key === key);
    // 'pending' (pre-confirm) shows step 0 grey, fall back to 0
    return Math.max(idx, 0);
  }, [order.status, steps]);

  const Icon = steps[statusIndex]?.icon ?? CheckCircle2;
  const delivery = order.deliveries[0];

  // Live map only once the driver has actually taken the job and while in flight.
  const liveDelivery =
    order.channel === 'delivery' &&
    delivery &&
    ((delivery.status === 'assigned' && delivery.accepted_at) ||
      delivery.status === 'picked_up' ||
      delivery.status === 'in_transit')
      ? delivery
      : null;
  // The open turn is the thread the diner can still write into. The ended ones are their own
  // record of the riders who came before — they were a party to those words, and only the
  // rider side of the leak was ever the privacy defect.
  const liveAssignment = assignments.find((a) => a.ended_at === null) ?? null;
  const pastAssignmentIds = assignments.filter((a) => a.ended_at !== null).map((a) => a.id);
  const showMap =
    !!liveDelivery && !!branchLocation && (branchLocation.lat !== 0 || branchLocation.lng !== 0) && hasMapboxToken();
  // set_driver_location computes this from a straight line at 24 km/h, and a rider whose
  // test fix sat in another country produced current_eta_min 37104 on the live project.
  // Whatever the row says, this page only ever prints a number a person can act on.
  const rawEta = delivery?.current_eta_min ?? delivery?.estimated_duration_min ?? null;
  const etaMin =
    rawEta != null && Number.isFinite(rawEta) ? Math.min(600, Math.max(1, Math.round(rawEta))) : null;
  // arriving_at outlived its rider too: a row handed back to dispatch kept the stamp, so the
  // page announced "almost there" for a delivery with no driver on it.
  const arriving = !!delivery?.arriving_at && delivery?.driver_id != null;

  // How old the pin is. The rider's app cannot report GPS from the background — iOS suspends
  // it, Android throttles it — and the app's own Navigate button sends them to Google Maps
  // for the drive. Until now the pin simply froze mid-street and the ETA kept counting down
  // beside it, which reads as a driver who has stopped. Age it out loud instead.
  const trackingLive = !!liveDelivery;
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!trackingLive) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 5_000);
    return () => window.clearInterval(id);
  }, [trackingLive]);
  const fixAge = fixAgeSeconds(delivery?.driver_location_updated_at ?? null, nowMs);
  const fixStale = trackingLive && isFixStale(fixAge);

  return (
    <div className="container max-w-xl pt-4">
      <header className="mb-5 flex items-center gap-3">
        <IconButton label="Back" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <div>
          <p className="text-xs text-muted-foreground">
            {t('orderNumber', { number: order.order_number })}
          </p>
          <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
        </div>
        <Badge variant="solid" className="ml-auto">
          {formatCurrency(Number(order.total))}
        </Badge>
      </header>

      <Card className="overflow-hidden p-0">
        {showMap && liveDelivery && branchLocation ? (
          <TrackingMap
            branch={branchLocation}
            delivery={liveDelivery}
            arriving={arriving}
            stale={fixStale}
            fixAge={fixAge}
          />
        ) : (
          <div className="relative bg-gradient-warm p-6 text-white">
            <div className="absolute inset-0 bg-noise opacity-30" />
            <div className="relative flex items-center gap-4">
              <motion.div
                key={statusIndex}
                initial={{ scale: 0.6, rotate: -15, opacity: 0 }}
                animate={{ scale: 1, rotate: 0, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 320, damping: 18 }}
                className="grid h-16 w-16 place-items-center rounded-2xl bg-white/20 backdrop-blur"
              >
                <Icon className="h-8 w-8" />
              </motion.div>
              <div>
                <p className="text-sm uppercase tracking-wider text-white/80">
                  {statusLabel(steps[statusIndex]?.key ?? 'confirmed')}
                </p>
                <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
                  {order.order_items.map((i) => `${i.quantity}× ${i.item_name}`).join(', ')}
                </h2>
              </div>
            </div>
          </div>
        )}

        {/* A frozen progress bar is indistinguishable from a slow kitchen, and the diner
            has no way to tell which they are looking at. Saying it is a connection
            problem is the difference between waiting patiently and phoning the shop. */}
        {!liveHealthy && (
          <p
            role="status"
            className="mx-5 mt-4 rounded-xl bg-warning/10 px-3 py-2 text-center text-xs text-foreground"
          >
            Reconnecting… this page may be a moment behind.
          </p>
        )}

        <div className="px-5 pb-5 pt-6">
          {/* Columns must track steps.length: dine-in/pickup have 4 stages, and
              a hardcoded 5 left an empty trailing column that the progress bar
              (already computed from steps.length) did not line up with. */}
          <ol
            className="relative grid gap-2"
            style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }}
          >
            <div className="absolute left-5 right-5 top-4 h-1 rounded-full bg-muted" />
            <motion.div
              className="absolute left-5 top-4 h-1 rounded-full bg-primary"
              initial={false}
              animate={{ width: `${(statusIndex / (steps.length - 1)) * (100 - 100 / steps.length)}%` }}
              transition={{ duration: 0.5 }}
            />
            {steps.map((step, i) => {
              const isDone = i <= statusIndex;
              const SIcon = step.icon;
              return (
                <li key={step.key} className="relative flex flex-col items-center gap-2">
                  <motion.div
                    animate={{
                      scale: i === statusIndex ? [1, 1.15, 1] : 1,
                      backgroundColor: isDone ? 'hsl(var(--primary))' : 'hsl(var(--muted))',
                      color: isDone ? 'hsl(var(--primary-foreground))' : 'hsl(var(--muted-foreground))',
                    }}
                    transition={{ duration: 0.4, repeat: i === statusIndex ? Infinity : 0, repeatDelay: 1 }}
                    className="relative z-10 grid h-9 w-9 place-items-center rounded-full"
                  >
                    <SIcon className="h-4 w-4" />
                  </motion.div>
                  <span className="text-center text-[10px] font-medium leading-tight text-muted-foreground">
                    {statusLabel(step.key)}
                  </span>
                </li>
              );
            })}
          </ol>

          {/* Card orders only — a cash order sitting in 'pending' is normal
              (staff confirm it) and must not be told its payment is unavailable.
              Guests can't read their payments row (RLS), so the box simply does
              not render for them, which is the right answer either way. */}
          {order.status === 'pending' && order.payments?.some((p) => p.method === 'card') && (
            <CardPaymentNotice orderId={order.id} />
          )}

          {/* QR transfer: the diner has already scanned and paid outside the app, so what
              is left is proving it. The order deliberately stays 'pending' until the
              restaurant approves the slip — a DB trigger enforces the same rule, so the
              kitchen cannot start early even from its own screen. */}
          {/* A refused slip now cancels the order. Say so plainly and give the reason the
              merchant typed, rather than leaving the customer on a progress bar that has
              quietly stopped advancing. */}
          {(order.status === 'cancelled' || order.status === 'refunded') && (
            <Card className="mt-6 border-danger/40 bg-danger/5 p-4">
              <p className="font-semibold text-danger">
                {order.status === 'refunded' ? 'This order was refunded' : 'This order was cancelled'}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {order.cancellation_reason
                  ? order.cancellation_reason
                  : 'Please contact the restaurant if you were not expecting this.'}
              </p>
            </Card>
          )}

          {order.payments
            ?.filter((p) => p.method === 'transfer')
            .map((p) => (
              <TransferProof
                key={p.id ?? 'transfer'}
                orderId={order.id}
                payment={p}
                total={Number(order.total)}
                qr={qrTransfer ?? null}
              />
            ))}

          {/* Gated on the same condition as the map, not on driver_id alone. Dispatch sets
              driver_id the moment it OFFERS the job, so this card used to appear — with Chat
              and Call — for a rider who had not accepted, and vanish again when they
              declined, blinking once per offer. accepted_at is the acceptance. */}
          {liveDelivery && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              className="mt-6 flex items-center justify-between rounded-2xl border border-border bg-muted/30 p-4"
            >
              <div className="flex items-center gap-3">
                <div className="grid h-12 w-12 place-items-center rounded-full bg-primary text-primary-foreground">
                  <Bike className="h-6 w-6" />
                </div>
                <div>
                  <p className="font-display text-base font-semibold">
                    {arriving
                      ? 'Your driver is almost there!'
                      : // Stop-2 of a stacked trip: honest while the driver is still on the
                        // first drop (assigned/picked_up). Once THIS leg is in_transit the
                        // driver is genuinely heading here — back to the normal copy.
                        liveDelivery.batch_seq === 2 &&
                          ['assigned', 'picked_up'].includes(liveDelivery.status)
                        ? 'Your driver is finishing one nearby delivery first'
                        : // 'assigned' means they are riding to the RESTAURANT. Calling that
                          // "on the way" and printing a minutes figure beside it is how the
                          // number came to be read as time-to-you when it was not.
                          liveDelivery.status === 'assigned'
                          ? 'Your driver is collecting your order'
                          : 'Your driver is on the way'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {liveDelivery.distance_km != null &&
                      `${kmToMi(liveDelivery.distance_km).toFixed(1)} mi · `}
                    {fixAge == null
                      ? 'Waiting for your driver’s location…'
                      : fixStale
                        ? `Location last updated ${formatFixAge(fixAge)} — the map and ETA may be behind`
                        : etaMin != null
                          ? `${etaMin} min to you · updated ${formatFixAge(fixAge)}`
                          : `Updated ${formatFixAge(fixAge)}`}
                    {liveDelivery.batch_seq === 2 &&
                      !arriving &&
                      ['assigned', 'picked_up'].includes(liveDelivery.status) &&
                      ' · includes their other stop'}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {/* Only the Chat button waits on a live turn — Call sits beside it and must
                    stay reachable while the order is between riders. */}
                {liveAssignment && (
                  <DeliveryChat
                    assignmentId={liveAssignment.id}
                    deliveryId={liveDelivery.id}
                    deliveryStatus={liveDelivery.status}
                    pastAssignmentIds={pastAssignmentIds}
                  />
                )}
                <CallDriverButton deliveryId={liveDelivery.id} label={t('callDriver')} />
              </div>
            </motion.div>
          )}

          {/* Order items summary */}
          <div className="mt-6 space-y-2 rounded-2xl bg-muted/40 p-4">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Items
            </p>
            <ul className="space-y-1.5 text-sm">
              {order.order_items.map((item, i) => (
                <li key={i} className="flex justify-between">
                  <span>
                    {item.quantity}× {item.item_name}
                  </span>
                </li>
              ))}
            </ul>
            <a
              href={`${pathname}/receipt`}
              className="focus-ring mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-primary underline"
            >
              <Receipt className="h-3.5 w-3.5" />
              View full receipt →
            </a>
          </div>
        </div>
      </Card>

      <div className="mt-4">
        <OrderActions
          awaitingPayment={order.awaiting_payment === true}
          orderId={order.id}
          branchId={branchId}
          orderStatus={order.status}
          existingRating={rating}
          hasDriver={!!delivery?.driver_id}
          driverId={delivery?.driver_id ?? null}
        />
      </div>
    </div>
  );
}

function TrackingMap({
  branch,
  delivery,
  arriving,
  stale,
  fixAge,
}: {
  branch: LatLng;
  delivery: DeliveryRow;
  arriving: boolean;
  stale: boolean;
  fixAge: number | null;
}) {
  const dropoff =
    delivery.dropoff_lat != null && delivery.dropoff_lng != null
      ? { lat: delivery.dropoff_lat, lng: delivery.dropoff_lng }
      : null;
  // Memoised on the numbers, not rebuilt per render: DeliveryMap moves the puck in an effect
  // keyed on this object, and a fresh literal every render made it re-run on every unrelated
  // state change. Now the marker moves when the rider does, and only then.
  //
  // driver_id gates the coordinates because the columns outlive the rider: until the
  // reassignment trigger existed, a delivery sent back out for dispatch kept the previous
  // rider's position, and this drew their pin for a job they had already dropped.
  const hasDriver = delivery.driver_id != null;
  const driverLat = hasDriver ? (delivery.driver_lat ?? null) : null;
  const driverLng = hasDriver ? (delivery.driver_lng ?? null) : null;
  const driver = React.useMemo(
    () => (driverLat != null && driverLng != null ? { lat: driverLat, lng: driverLng } : null),
    [driverLat, driverLng],
  );
  const [route, setRoute] = React.useState<[number, number][] | null>(null);

  // One Directions call per tracking session (cost control) — the trip path
  // branch → dropoff. Live position rides on realtime, not on this API.
  React.useEffect(() => {
    if (!dropoff) return;
    let cancelled = false;
    void fetchRoute(branch, dropoff).then((r) => {
      if (!cancelled) setRoute(r);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative h-60">
      <DeliveryMap
        branch={branch}
        dropoff={dropoff}
        driver={driver}
        routeCoordinates={route}
        driverStale={stale}
        className="h-full w-full"
      />
      {/* "Arriving now" on top of a pin nobody has heard from in two minutes is the worst of
          both: it sends the diner to the door for a rider who may still be streets away. */}
      {arriving && !stale && (
        <span className="absolute left-3 top-3 z-10 rounded-full bg-success px-3 py-1.5 text-xs font-bold text-white shadow-lg">
          🛵 Arriving now
        </span>
      )}
      {stale && fixAge != null && (
        <span
          role="status"
          className="absolute right-3 top-3 z-10 rounded-full bg-card/90 px-3 py-1.5 text-xs font-semibold text-muted-foreground shadow"
        >
          Last seen {formatFixAge(fixAge)}
        </span>
      )}
    </div>
  );
}

function CallDriverButton({ deliveryId, label }: { deliveryId: string; label: string }) {
  const [loading, setLoading] = React.useState(false);
  const [unavailable, setUnavailable] = React.useState(false);

  const call = async () => {
    setLoading(true);
    const supabase = getBrowserClient();
    // Driver phone is gated server-side: only this order's customer, only in flight.
    const { data } = await supabase.rpc('get_delivery_driver_contact', {
      p_delivery_id: deliveryId,
    } as never);
    setLoading(false);
    const phone = data as unknown as string | null;
    if (phone) {
      window.location.href = `tel:${phone}`;
    } else {
      setUnavailable(true);
    }
  };

  if (unavailable) return null;
  return (
    <Button variant="soft" size="md" leftIcon={<Phone className="h-4 w-4" />} onClick={call} loading={loading}>
      {label}
    </Button>
  );
}

// Card money cannot be collected on this storefront, and no key changes that.
//
// Nothing in apps/web mounts Stripe Elements, and `stripe-create-payment-intent` creates
// the intent with `automatic_payment_methods` — an intent only a PaymentElement plus
// `stripe.confirmPayment({ elements, confirmParams: { return_url } })` can confirm. What
// stood here instead was `stripe.confirmCardPayment(clientSecret)` with no card attached:
// it could never succeed, so the diner's one card button led to an error and every card
// payment ever taken on this project is still sitting at 'pending'.
//
// A half-working card flow is worse than an honest one, so the button is gone and the box
// says where to actually pay. Checkout no longer offers the card tile for the same reason
// (CARD_CHECKOUT_AVAILABLE in checkout-view); these are the orders placed before it did.
// Restoring the button means mounting Elements and letting the existing stripe-webhook
// `payment_intent.succeeded` handler flip payments+orders — not re-adding a confirm call.
const ALLOW_MOCK_PAY = process.env.NODE_ENV !== 'production';

function CardPaymentNotice({ orderId }: { orderId: string }) {
  const [confirming, setConfirming] = React.useState(false);

  const mockConfirm = async () => {
    if (!ALLOW_MOCK_PAY) return;
    setConfirming(true);
    const supabase = getBrowserClient();
    await supabase
      .from('payments')
      .update({ status: 'completed', paid_at: new Date().toISOString() })
      .eq('order_id', orderId);
    await supabase.from('orders').update({ status: 'confirmed' }).eq('id', orderId);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      role="status"
      className="mt-6 rounded-2xl border border-warning/40 bg-warning/5 p-4"
    >
      <p className="text-sm font-semibold text-warning">Card payment isn&apos;t available here</p>
      <p className="mt-1 text-xs text-muted-foreground">
        This order was placed as a card payment, but we can&apos;t take the card online yet.
        Please pay the restaurant directly — they can take it when you collect your order or
        when it arrives. Your order is not cancelled.
      </p>
      {ALLOW_MOCK_PAY && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Development build only: mark the order paid so the rest of the flow can be tested.
          </p>
          <Button
            variant="outline"
            size="md"
            fullWidth
            loading={confirming}
            onClick={mockConfirm}
          >
            Mock confirm (dev only)
          </Button>
        </div>
      )}
    </motion.div>
  );
}

/**
 * QR-transfer proof. The diner pays outside the app, then uploads the slip here.
 *
 * The upload goes to the PRIVATE `payment-proofs` bucket and the URL is recorded through
 * `submit_payment_proof`, a SECURITY DEFINER RPC — deliberately not a table UPDATE, so
 * `payments.status` stays out of the customer's reach. Approval is the merchant's.
 */
function TransferProof({
  orderId,
  payment,
  total,
  qr,
}: {
  orderId: string;
  payment: {
    method: string;
    status: string;
    proof_image_url?: string | null;
    gateway_metadata?: Record<string, unknown> | null;
  };
  total: number;
  qr: QrTransfer | null;
}) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const note = (payment.gateway_metadata?.decision_note as string | undefined) ?? null;
  // Held locally as well as read from the server row. router.refresh() re-renders a server
  // component, and until that round-trip lands the screen still showed "Upload your transfer
  // slip" with no image — indistinguishable from the upload having failed, which is exactly
  // how it was reported. The local value wins immediately.
  const [justUploaded, setJustUploaded] = React.useState<string | null>(null);
  const proofPath = justUploaded ?? payment.proof_image_url ?? null;
  const submitted = !!proofPath;
  // Uploading a slip and saying "I have paid" are two different acts. The merchant is only
  // asked to look once the diner confirms — before that they may still be swapping a
  // screenshot, and an approval queue full of half-finished uploads is noise.
  const [justConfirmed, setJustConfirmed] = React.useState(false);
  const confirmed = justConfirmed || !!payment.gateway_metadata?.customer_confirmed_at;
  const [confirming, setConfirming] = React.useState(false);

  const confirmPaid = async () => {
    setConfirming(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('confirm_payment_proof', { p_order_id: orderId });
    setConfirming(false);
    if (rpcErr) {
      setError(rpcErr.hint ?? rpcErr.message);
      return;
    }
    setJustConfirmed(true);
    router.refresh();
  };
  // payment-proofs is a private bucket, so the slip needs a signed URL to be shown back.
  // Without this the customer had no way to see what they had sent — the button simply
  // vanished on success, which reads as "the upload failed", which is what was reported.
  const [slipUrl, setSlipUrl] = React.useState<string | null>(null);
  React.useEffect(() => {
    const path = proofPath;
    if (!path) {
      setSlipUrl(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase.storage
        .from('payment-proofs')
        .createSignedUrl(path, 60 * 10);
      if (!cancelled) setSlipUrl(data?.signedUrl ?? null);
    })();
    return () => {
      cancelled = true;
    };
  }, [proofPath]);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) {
        throw new Error('Please upload a PNG, JPEG or WebP photo of your slip.');
      }
      if (file.size > 10 * 1024 * 1024) throw new Error('That image is larger than 10 MB.');
      const supabase = getBrowserClient();
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const path = `${orderId}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('payment-proofs')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw new Error(upErr.message);
      const { error: rpcErr } = await supabase.rpc('submit_payment_proof', {
        p_order_id: orderId,
        p_path: path,
      });
      if (rpcErr) throw new Error(rpcErr.message);
      setJustUploaded(path);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (payment.status === 'completed') {
    return (
      <Card className="mt-6 border-success/40 bg-success/5 p-4">
        <p className="flex items-center gap-2 font-semibold text-success">
          <CheckCircle2 className="h-5 w-5" /> Transfer confirmed
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          The restaurant has checked your slip and started your order.
        </p>
      </Card>
    );
  }

  const rejected = payment.status === 'failed';

  return (
    <Card className={`mt-6 p-4 ${rejected ? 'border-danger/40 bg-danger/5' : ''}`}>
      <p className="font-semibold">
        {rejected
          ? 'Your transfer slip was not accepted'
          : confirmed
            ? 'Waiting for the restaurant to check your slip'
            : submitted
              ? 'Check your slip, then confirm'
              : `Pay ${formatCurrency(total)} to continue`}
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        {rejected
          ? note
            ? `Reason: ${note}`
            : 'Please upload a clearer photo of the transfer.'
          : confirmed
            ? 'We will start your order as soon as they confirm it. This usually takes a few minutes.'
            : submitted
              ? 'Have a look at the photo below. Replace it if it is not right, then confirm you have paid — that is what sends it to the restaurant.'
              : 'Scan the code, transfer the total, then upload a photo of the confirmation.'}
      </p>

      {/* The QR lives here rather than at checkout: the diner now has a real order number to
          put in the transfer note, and nothing is asked of them until the order exists. */}
      {!confirmed && qr?.image_url && (
        <div className="mt-3 rounded-2xl border border-border bg-muted/30 p-4 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={qr.image_url}
            alt="Payment QR code"
            className="mx-auto h-48 w-48 rounded-xl bg-white object-contain p-2"
          />
          {qr.account_name && <p className="mt-2 text-sm font-medium">{qr.account_name}</p>}
          {qr.instructions && (
            <p className="mt-1 text-xs text-muted-foreground">{qr.instructions}</p>
          )}
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
      {/* Show the slip back. It is the only confirmation the customer gets that the upload
          worked at all, and the only way to notice they photographed the wrong screen. */}
      {slipUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={slipUrl}
          alt="Your transfer slip"
          className="mt-3 max-h-64 w-full rounded-xl border border-border object-contain"
        />
      )}

      {/* Replaceable right up until the diner confirms — after that it is with the merchant
          and swapping it underneath them would be dishonest. A rejection reopens it. */}
      {(!confirmed || rejected) && (
        <Button
          className="mt-3"
          fullWidth
          variant={submitted ? 'outline' : 'gradient'}
          loading={busy}
          onClick={() => inputRef.current?.click()}
        >
          {submitted ? 'Upload a different photo' : 'Choose photo'}
        </Button>
      )}
      {submitted && (!confirmed || rejected) && (
        <Button className="mt-2" fullWidth loading={confirming} onClick={confirmPaid}>
          I&apos;ve paid — send to the restaurant
        </Button>
      )}
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
    </Card>
  );
}
