'use client';

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Bike, CheckCircle2, Coffee, MapPin, Navigation, Package, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { Button, Card, EmptyState } from '@favornoms/ui';
import { DeliveryMap, fetchRoute, hasMapboxToken, haversineKm } from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';
import {
  useDelivery,
  type ActiveDeliveryUI,
  type EndedJobNotice,
} from '@/components/delivery-provider';
import { useDriver } from '@/store/driver';
import {
  cancelDelivery,
  failDelivery,
  progressDelivery,
  type DeliveryStatus,
} from '@favornoms/database/queries';
import { DriverDeliveryChat } from './delivery-chat';
import { PhotoUploader } from './photo-uploader';

type ActiveT = ReturnType<typeof useTranslations<'active'>>;

/** How close the rider must be before "I'm at the restaurant" / "I've arrived" unlock.
 *  Owner's number. Wide enough for GPS drift and a car park, tight enough that it cannot be
 *  pressed from the other side of town. */
const ARRIVAL_RADIUS_MI = 0.2;

/**
 * progress_delivery raises bare codes, and anything a trigger raises underneath it arrives
 * here as raw Postgres text. Name the ones a rider can act on; for the rest say plainly that
 * it is not their fault and not worth retrying, and show the reason so it can be reported.
 */
function advanceErrorMessage(e: unknown, t: ActiveT): string {
  const raw = e instanceof Error ? e.message : String(e ?? '');
  if (raw.includes('pod_photo_required')) return t('errors.podPhotoRequired');
  if (raw.includes('pickup_photo_required')) return t('errors.pickupPhotoRequired');
  if (raw.includes('not_accepted')) return t('errors.notAccepted');
  if (raw.includes('illegal_transition')) {
    return t('errors.alreadyMoved');
  }
  if (raw.includes('forbidden')) return t('errors.forbidden');
  return t('errors.unknown', { reason: raw.slice(0, 120) });
}

type StageKey = 'heading_to_pickup' | 'at_pickup' | 'picked_up' | 'in_transit' | 'at_customer';

const stageMeta: Record<
  StageKey,
  {
    titleKey: 'headToPickup' | 'atPickup' | 'onTheWay' | 'atCustomer';
    ctaKey: 'atPickup' | 'pickedUp' | 'atCustomer' | 'delivered';
    icon: React.ComponentType<{ className?: string }>;
    color: string;
    /** What delivery_status to transition to when CTA is tapped. null = soft state only. */
    transition: DeliveryStatus | null;
    /** Next soft state if transition is null. */
    nextStage?: StageKey;
  }
> = {
  heading_to_pickup: {
    titleKey: 'headToPickup',
    ctaKey: 'atPickup',
    icon: Coffee,
    color: 'from-primary to-accent',
    transition: null,
    nextStage: 'at_pickup',
  },
  at_pickup: {
    titleKey: 'atPickup',
    ctaKey: 'pickedUp',
    icon: Package,
    color: 'from-secondary to-primary',
    transition: 'picked_up',
  },
  // 'picked_up' is no longer a screen the driver stops on. Collecting the bag and setting
  // off are one act, so at_pickup drives the row through picked_up AND in_transit together
  // (see handleAdvance) and the rider lands straight on "On the way". The stage is kept
  // only so a resync that catches the row mid-transition has somewhere to sit.
  picked_up: {
    titleKey: 'onTheWay',
    ctaKey: 'atCustomer',
    icon: Bike,
    color: 'from-accent to-primary',
    transition: 'in_transit',
  },
  in_transit: {
    titleKey: 'onTheWay',
    ctaKey: 'atCustomer',
    icon: Bike,
    color: 'from-accent to-primary',
    transition: null,
    nextStage: 'at_customer',
  },
  at_customer: {
    titleKey: 'atCustomer',
    ctaKey: 'delivered',
    icon: MapPin,
    color: 'from-primary to-secondary',
    transition: 'delivered',
  },
};

function softStageFromStatus(active: ActiveDeliveryUI, soft: StageKey): StageKey {
  // Server status takes precedence when it's further along than the local soft state.
  switch (active.status) {
    case 'assigned':
      return soft === 'at_pickup' ? 'at_pickup' : 'heading_to_pickup';
    case 'picked_up':
      return 'picked_up';
    case 'in_transit':
      return soft === 'at_customer' ? 'at_customer' : 'in_transit';
    default:
      return soft;
  }
}

export function ActiveDeliveryView() {
  const t = useTranslations('active');
  const { active, progress, markArriving, lastEnded, dismissLastEnded } = useDelivery();
  const [advancing, setAdvancing] = React.useState(false);
  const [driverPos, setDriverPos] = React.useState<{ lat: number; lng: number } | null>(null);
  const [geoWatchDenied, setGeoWatchDenied] = React.useState(false);
  // The location ping is the thing dispatch and the customer's map depend on, and it lives
  // in the app shell. Its verdict and this screen's own watch used to disagree — one screen
  // said location was off while the other said nothing at all — so read both.
  const gps = useDriver((s) => s.gps);
  const geoDenied = geoWatchDenied || gps === 'denied' || gps === 'insecure';
  const [route, setRoute] = React.useState<[number, number][] | null>(null);
  const [completed, setCompleted] = React.useState<{ earnings: number; orderNumber: string } | null>(null);
  const [advanceError, setAdvanceError] = React.useState<string | null>(null);
  // Which arrival step the rider has explicitly overridden the distance check for. Stored as
  // the stage rather than a boolean so it expires by itself: once the job moves on, the value
  // no longer matches the current stage and the next arrival step is gated again.
  const [arrivalOverride, setArrivalOverride] = React.useState<StageKey | null>(null);
  // Local echoes of the just-uploaded proof photos for instant CTA-unlock
  // (the provider also picks them up from the server on its next realtime resync).
  const [pickupPhotoUrl, setPickupPhotoUrl] = React.useState<string | null>(null);
  const [podPhotoUrl, setPodPhotoUrl] = React.useState<string | null>(null);
  // Batched job (งานพ่วง): the second order needs its OWN pickup photo — one photo
  // per bag is the wrong-bag safeguard.
  const [matePickupPhotoUrl, setMatePickupPhotoUrl] = React.useState<string | null>(null);
  // Local soft stage for transitions that don't map to a DB status change
  // (e.g. "I'm at the restaurant" is a UI-only step; only "Picked up" changes the row).
  const [softStage, setSoftStage] = React.useState<StageKey>('heading_to_pickup');

  // Reset the local echoes when the active job changes — and only then. A null `active` is
  // "we have momentarily lost sight of the job", not "a new job started": keying this on
  // active?.id alone meant a single dropped refetch ran the reset twice through undefined,
  // greying out "Mark as delivered" on a rider who had already taken the photo.
  const lastJobIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    const id = active?.id ?? null;
    if (id === null || id === lastJobIdRef.current) return;
    lastJobIdRef.current = id;
    setPickupPhotoUrl(null);
    setPodPhotoUrl(null);
    setMatePickupPhotoUrl(null);
    // A distance override belongs to one step of one job — never carry it into the next.
    setArrivalOverride(null);
    // The soft stage belongs to the job too; the sync effect below then pulls it forward to
    // wherever the server says this one already is.
    setSoftStage('heading_to_pickup');
  }, [active?.id]);

  // Watch GPS for the live route map (separate from DriverLocationPing's DB push) +
  // surface a permission-denied state so the driver isn't silently invisible.
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setDriverPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoWatchDenied(false);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setGeoWatchDenied(true);
      },
      // Was 15s. This position drives the rider's own map marker and the arrival distance
      // check, so a fix that may be a quarter-minute stale is too old for both — the map
      // lagged behind the road, and "how far am I" answered for where they used to be.
      { enableHighAccuracy: true, maximumAge: 3_000, timeout: 15_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  // One Directions call for the branch → dropoff route line on the map.
  React.useEffect(() => {
    const bLat = active?.branchLat, bLng = active?.branchLng;
    const dLat = active?.dropoffLat, dLng = active?.dropoffLng;
    if (bLat == null || bLng == null || dLat == null || dLng == null) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    void fetchRoute({ lat: bLat, lng: bLng }, { lat: dLat, lng: dLng }).then((r) => {
      if (!cancelled) setRoute(r);
    });
    return () => {
      cancelled = true;
    };
  }, [active?.branchLat, active?.branchLng, active?.dropoffLat, active?.dropoffLng]);

  // Sync soft stage with server-side status on mount/refresh. Preserve the local
  // "arrived" sub-steps (at_pickup / at_customer) so a realtime resync — e.g. the
  // one markArriving() triggers — doesn't yank the driver back a step.
  //
  // Only the status can move this, so only the status is a dependency: `active` itself is a
  // new object on every resync, and a momentary null is not the job restarting. Between them
  // those two facts used to throw a rider standing at the customer's door back to "Head to
  // pickup" — different card, different icon, different button — and then forward again.
  React.useEffect(() => {
    const status = active?.status;
    if (status === 'picked_up') setSoftStage('picked_up');
    else if (status === 'in_transit') {
      setSoftStage((prev) => (prev === 'at_customer' ? 'at_customer' : 'in_transit'));
    } else if (status === 'assigned') {
      setSoftStage((prev) => (prev === 'at_pickup' ? 'at_pickup' : 'heading_to_pickup'));
    }
  }, [active?.id, active?.status]);

  if (!active) {
    // Just finished a delivery → celebrate + show credited earnings + hand to the next run.
    if (completed) {
      return (
        <div className="grid min-h-[70vh] place-items-center px-6">
          <motion.div
            initial={{ scale: 0.85, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            transition={{ type: 'spring', stiffness: 260, damping: 18 }}
            className="w-full max-w-sm text-center"
          >
            <div className="mx-auto grid h-20 w-20 place-items-center rounded-full bg-success text-white shadow-warm">
              <CheckCircle2 className="h-10 w-10" />
            </div>
            <h1 className="mt-5 font-display text-2xl font-bold">{t('complete.title')}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{completed.orderNumber}</p>
            <div className="mt-5 rounded-2xl bg-muted/50 px-5 py-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('complete.earningsAdded')}
              </p>
              <p className="font-display text-3xl font-bold text-primary">
                {formatCurrency(completed.earnings)}
              </p>
            </div>
            <Link href="/app/home" className="mt-6 block">
              <Button variant="gradient" size="xl" fullWidth onClick={() => setCompleted(null)}>
                {t('complete.findNext')}
              </Button>
            </Link>
          </motion.div>
        </div>
      );
    }
    return (
      <div className="px-4 pt-6">
        {lastEnded && <TakenAwayNotice notice={lastEnded} onDismiss={dismissLastEnded} />}
        <EmptyState
          icon={<Navigation className="h-7 w-7" />}
          title={t('noActive')}
          description={t('noActiveDescription')}
          action={
            <Link href="/app/home">
              <Button variant="gradient" size="lg">
                {t('goHome')}
              </Button>
            </Link>
          }
        />
      </div>
    );
  }

  const stage = softStageFromStatus(active, softStage);
  const meta = stageMeta[stage];
  const StageIcon = meta.icon;

  // Proof of pickup is mandatory: at the restaurant the driver must snap a photo
  // before "Picked up" unlocks. Trust either the fresh local upload or the server row.
  // Distance to whatever the rider is currently heading for, in miles. null when we have no
  // fix yet — which must read as "we cannot tell", never as "you have arrived".
  const arrivalTarget =
    stage === 'heading_to_pickup'
      ? { lat: active.branchLat, lng: active.branchLng, kind: 'restaurant' as const }
      : { lat: active.dropoffLat, lng: active.dropoffLng, kind: 'dropoff' as const };
  const milesToTarget =
    driverPos && arrivalTarget.lat != null && arrivalTarget.lng != null
      ? kmToMi(
          haversineKm(
            { lat: driverPos.lat, lng: driverPos.lng },
            { lat: arrivalTarget.lat, lng: arrivalTarget.lng },
          ),
        )
      : null;
  // Only the two "I am here" steps are gated. Everything else is unaffected.
  const isArrivalStep = stage === 'heading_to_pickup' || stage === 'in_transit';
  // A branch or address with no coordinates cannot be checked against, and blocking the job
  // over missing data the rider cannot fix would strand them mid-delivery.
  const targetKnown = arrivalTarget.lat != null && arrivalTarget.lng != null;
  const tooFarToArrive =
    isArrivalStep && targetKnown && (milesToTarget == null || milesToTarget > ARRIVAL_RADIUS_MI);
  // The rider has said "I am here regardless" for THIS step. Recorded on the delivery when
  // they advance, so the gate can be got past without the gate becoming meaningless.
  const arrivalOverridden = arrivalOverride === stage;
  const blockedByDistance = tooFarToArrive && !arrivalOverridden;

  const hasPickupPhoto = !!pickupPhotoUrl || !!active.pickupPhotoUrl;
  const needsPickupPhoto = stage === 'at_pickup' && !hasPickupPhoto;
  // Proof of delivery is mandatory: at the customer the driver must snap a photo
  // before "Mark as delivered" unlocks.
  const hasPodPhoto = !!podPhotoUrl || !!active.podPhotoUrl;
  const needsPodPhoto = stage === 'at_customer' && !hasPodPhoto;
  // Batched job: the second leg (still 'assigned') is picked up at the same counter —
  // its photo + picked_up transition happen together with the first leg's.
  const mate = active.batchMate;
  const matePendingPickup = !!mate && mate.status === 'assigned';
  const hasMatePickupPhoto = !!matePickupPhotoUrl || !!mate?.pickupPhotoUrl;
  const needsMatePickupPhoto = stage === 'at_pickup' && matePendingPickup && !hasMatePickupPhoto;

  const handleAdvance = async () => {
    if (advancing) return; // guard against double-fire
    // Belt-and-braces: the CTA is already disabled, but never advance to picked_up
    // without the pickup photo, nor finish without the delivery photo
    // (progress_delivery also enforces both server-side).
    if (meta.transition === 'picked_up' && !hasPickupPhoto) {
      setAdvanceError(t('errors.pickupPhotoRequired'));
      return;
    }
    if (meta.transition === 'picked_up' && needsMatePickupPhoto) {
      setAdvanceError(t('errors.pickupPhotoBoth'));
      return;
    }
    if (meta.transition === 'delivered' && !hasPodPhoto) {
      setAdvanceError(t('errors.podPhotoRequired'));
      return;
    }
    if ('vibrate' in navigator) navigator.vibrate(40);
    setAdvancing(true);
    setAdvanceError(null);
    try {
      // Record the skip on the delivery BEFORE it moves, so the step that was allowed
      // through carries the reason with it. Never fatal: the gate is a safeguard, not a
      // paywall, and failing to write the audit line must not strand a rider at the door.
      if (tooFarToArrive && arrivalOverridden) {
        try {
          const supabase = getBrowserClient();
          await supabase.rpc('record_arrival_override', {
            p_delivery_id: active.id,
            p_stage: stage,
            p_miles: milesToTarget,
          });
        } catch {
          /* the delivery matters more than its audit line */
        }
      }
      if (meta.transition === 'delivered') {
        const snap = active;
        // Throws if the guarded RPC rejects — so we never show a false completion.
        await progress('delivered');
        // Show the actually-credited earnings (incl. any peak bonus applied on the
        // delivered transition), falling back to the offered amount.
        let earnings = snap.driverEarnings;
        try {
          const supabase = getBrowserClient();
          const { data } = await supabase
            .from('deliveries')
            .select('driver_earnings')
            .eq('id', snap.id)
            .maybeSingle();
          if (data?.driver_earnings != null) earnings = Number(data.driver_earnings);
        } catch {
          /* keep the snapshot earnings */
        }
        setCompleted({ earnings, orderNumber: snap.orderNumber });
      } else if (meta.transition === 'picked_up') {
        // Collecting the bag and setting off are one act now — the separate "start delivery"
        // tap was a screen with nothing on it to decide. Batched jobs still mark the sibling
        // picked up first, exactly as before.
        const supabase = getBrowserClient();
        if (mate && matePendingPickup) {
          const { error: mateErr } = await progressDelivery(supabase, mate.id, 'picked_up');
          if (mateErr) throw new Error(mateErr.message);
        }
        await progress('picked_up');
        // Straight on to in_transit. A failure here is not fatal: the row is legitimately
        // picked_up, the stage machine will show the on-the-way screen from the server
        // status, and the rider can carry on.
        try {
          await progress('in_transit');
        } catch {
          /* stays at picked_up; the board and the customer both read that correctly */
        }
      } else if (meta.transition) {
        await progress(meta.transition);
      } else if (meta.nextStage) {
        // Soft UI-only step. If it's "arrived at the customer", also persist arriving_at
        // so the customer gets the "arriving now" push + map badge.
        if (meta.nextStage === 'at_customer') await markArriving();
        setSoftStage(meta.nextStage);
      }
    } catch (e) {
      // Server rejected the step (already resynced by progress()). Surface it instead
      // of optimistically advancing or faking a completion.
      //
      // The reason used to be thrown away for a flat "please try again", which is exactly
      // wrong when the cause is not transient: a broken earnings trigger made every
      // "Mark as delivered" fail, and the message invited a retry that could never work.
      setAdvanceError(advanceErrorMessage(e, t));
    } finally {
      setAdvancing(false);
    }
  };

  const isHeading = stage === 'heading_to_pickup' || stage === 'at_pickup';
  const isInTransit = stage === 'picked_up' || stage === 'in_transit' || stage === 'at_customer';

  const branchLL =
    active.branchLat != null && active.branchLng != null
      ? { lat: active.branchLat, lng: active.branchLng }
      : null;
  const dropoffLL =
    active.dropoffLat != null && active.dropoffLng != null
      ? { lat: active.dropoffLat, lng: active.dropoffLng }
      : null;
  const showMap = hasMapboxToken() && !!branchLL;

  return (
    <div className="relative">
      {lastEnded && (
        <div className="px-4 pt-4">
          <TakenAwayNotice notice={lastEnded} onDismiss={dismissLastEnded} />
        </div>
      )}
      <section className="relative h-[42vh] overflow-hidden bg-muted">
        {showMap && branchLL ? (
          <DeliveryMap
            branch={branchLL}
            dropoff={dropoffLL}
            driver={driverPos}
            routeCoordinates={route}
            className="h-full w-full"
          />
        ) : (
          <div className="grid h-full place-items-center bg-gradient-to-b from-primary/10 to-card/80 text-center text-sm text-muted-foreground">
            <p className="px-6">
              {hasMapboxToken() ? t('map.liveUnavailable') : t('map.unavailable')}
            </p>
          </div>
        )}

        <div className="pointer-events-none absolute left-4 right-4 top-4 flex items-center justify-between [&>*]:pointer-events-auto">
          <span className="rounded-full bg-card/90 px-3 py-1.5 text-xs font-semibold backdrop-blur">
            {t('map.tripSummary', {
              miles: kmToMi(active.distanceKm).toFixed(1),
              minutes: String(active.estimatedDurationMin),
            })}
          </span>
          <NavigateMenu
            lat={isHeading ? active.branchLat : active.dropoffLat}
            lng={isHeading ? active.branchLng : active.dropoffLng}
            address={isHeading ? active.branchAddress : active.customerAddress}
          />
        </div>
      </section>

      <section className="relative -mt-6 px-4">
        <Card className="overflow-hidden p-0 shadow-warm">
          <motion.div
            key={stage}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            className={`bg-gradient-to-r ${meta.color} px-5 py-4 text-white`}
          >
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/20 backdrop-blur">
                <StageIcon className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-white/80">
                  {active.batchSeq != null
                    ? t('headerWithStop', {
                        orderNumber: active.orderNumber,
                        seq: String(active.batchSeq),
                      })
                    : active.orderNumber}
                </p>
                <h2 className="font-display text-xl font-bold leading-tight">
                  {t(meta.titleKey)}
                </h2>
              </div>
            </div>
          </motion.div>

          <div className="space-y-4 p-5">
            {geoDenied ? (
              <div
                role="alert"
                className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs font-medium text-warning"
              >
                📍{' '}
                {gps === 'insecure' ? t('location.insecure') : t('location.off')}
              </div>
            ) : (
              // A browser cannot report GPS from the background, and Navigate below sends the
              // rider into Google Maps for the drive. Say so once, here, rather than leaving
              // the customer's pin frozen with nobody able to explain it.
              <p className="rounded-2xl bg-muted/50 px-4 py-2.5 text-xs text-muted-foreground">
                📍 {t('location.sharedWhileOpen')}
              </p>
            )}
            <Step
              done={isInTransit}
              icon={<Coffee className="h-5 w-5" />}
              title={t('steps.pickup')}
              primary={active.branchName}
              secondary={active.branchAddress}
            />
            <Step
              done={stage === 'at_customer'}
              icon={<MapPin className="h-5 w-5" />}
              title={mate ? t('steps.dropoffStop1') : t('steps.dropoff')}
              primary={active.customerName}
              secondary={active.customerAddress}
            />
            {mate && (
              <Step
                done={false}
                icon={<MapPin className="h-5 w-5" />}
                title={t('steps.dropoffStop2')}
                primary={mate.customerName}
                secondary={mate.customerAddress}
              />
            )}

            {isInTransit ? (
              <DropoffInstructionsCard active={active} />
            ) : (
              active.dropoffNotes && (
                <div className="rounded-2xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
                  <span className="font-semibold">📍 {t('deliveryNote')}</span> {active.dropoffNotes}
                </div>
              )
            )}

            <div className="flex items-center justify-between rounded-2xl bg-muted/40 px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">
                  {mate ? t('earningBatch') : t('earning')}
                </p>
                <p className="font-display text-xl font-bold text-primary">
                  {formatCurrency(active.driverEarnings + (mate?.driverEarnings ?? 0))}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {/* Gated on the turn, not on the delivery. Without an open assignment there
                    is no thread to open, and falling back to the delivery is exactly how a
                    replacement rider used to inherit the last one's conversation. */}
                {active.assignmentId && (
                  <DriverDeliveryChat
                    assignmentId={active.assignmentId}
                    deliveryId={active.id}
                    deliveryStatus={active.status}
                  />
                )}
                {active.customerPhone && (
                  <a href={`tel:${active.customerPhone}`}>
                    <Button variant="soft" leftIcon={<Phone className="h-4 w-4" />} size="md">
                      {t('callCustomer')}
                    </Button>
                  </a>
                )}
              </div>
            </div>

            {stage === 'at_pickup' && (
              <>
                {mate && matePendingPickup && (
                  <p className="text-xs font-semibold text-muted-foreground">
                    📦 {t('pickupOrder1', { orderNumber: active.orderNumber })}
                  </p>
                )}
                <PhotoUploader
                  mode="pickup"
                  deliveryId={active.id}
                  uploadedUrl={pickupPhotoUrl ?? active.pickupPhotoUrl}
                  onUploaded={setPickupPhotoUrl}
                />
                {mate && matePendingPickup && (
                  <>
                    <p className="text-xs font-semibold text-muted-foreground">
                      📦 {t('pickupOrder2', { orderNumber: mate.orderNumber })}
                    </p>
                    <PhotoUploader
                      mode="pickup"
                      deliveryId={mate.id}
                      uploadedUrl={matePickupPhotoUrl ?? mate.pickupPhotoUrl}
                      onUploaded={setMatePickupPhotoUrl}
                    />
                  </>
                )}
              </>
            )}
            {stage === 'at_customer' && (
              <PhotoUploader
                mode="delivery"
                deliveryId={active.id}
                uploadedUrl={podPhotoUrl ?? active.podPhotoUrl}
                onUploaded={setPodPhotoUrl}
              />
            )}
            <Button
              variant="gradient"
              size="xl"
              fullWidth
              onClick={handleAdvance}
              loading={advancing}
              disabled={advancing || needsPickupPhoto || needsPodPhoto || needsMatePickupPhoto || blockedByDistance}
            >
              {t(meta.ctaKey)}
            </Button>
            {/* Why the button is dead, in the rider's own terms. Silently disabling it is
                how "the app is broken" reports start. */}
            {blockedByDistance && (
              <>
                <p className="mt-2 text-center text-xs text-muted-foreground">
                  {milesToTarget == null
                    ? geoDenied
                      ? t(`arrival.turnOnLocation.${arrivalTarget.kind}`)
                      : t(`arrival.waiting.${arrivalTarget.kind}`)
                    : t(`arrival.tooFar.${arrivalTarget.kind}`, {
                        miles: milesToTarget.toFixed(1),
                        radius: String(ARRIVAL_RADIUS_MI),
                      })}
                </p>
                {/* GPS does fail — indoors, in a canyon of buildings, or when the branch pin
                    itself is wrong — and a rider standing at the counter with a dead button
                    has nowhere to go. Deliberately plain rather than inviting: a second tap,
                    and the delivery records that it was used. */}
                <button
                  type="button"
                  onClick={() => setArrivalOverride(stage)}
                  className="focus-ring mx-auto mt-1 block rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground underline underline-offset-4"
                >
                  {t(`arrival.override.${arrivalTarget.kind}`)}
                </button>
              </>
            )}
            {tooFarToArrive && arrivalOverridden && (
              <p className="mt-2 text-center text-xs text-muted-foreground">
                {t('arrival.skipped')}
              </p>
            )}
            {(needsPickupPhoto || needsMatePickupPhoto) && (
              <p className="text-center text-xs text-muted-foreground">
                📸{' '}
                {needsMatePickupPhoto && !needsPickupPhoto
                  ? t('photoNeeded.secondOrder')
                  : mate
                    ? t('photoNeeded.eachOrder')
                    : t('photoNeeded.pickup')}
              </p>
            )}
            {needsPodPhoto && (
              <p className="text-center text-xs text-muted-foreground">
                📸 {t('photoNeeded.delivery')}
              </p>
            )}
            {advanceError && (
              <p className="text-center text-xs font-medium text-danger">{advanceError}</p>
            )}

            <DeliveryIssuePanel active={active} />
          </div>
        </Card>
      </section>
    </div>
  );
}

/**
 * A job leaving this phone without the rider touching anything used to be silent at best: the
 * card either froze until the app was next focused, or vanished with no explanation. Say who
 * took it and, when somebody typed one, what they said.
 */
function TakenAwayNotice({
  notice,
  onDismiss,
}: {
  notice: EndedJobNotice;
  onDismiss: () => void;
}) {
  const t = useTranslations('active');
  const what =
    notice.endKind === 'order_cancelled'
      ? t('takenAway.orderCancelled')
      : notice.endKind === 'reassigned_by_staff'
        ? t('takenAway.reassigned')
        : notice.endKind === 'requeued_by_staff'
          ? t('takenAway.requeued')
          : notice.endKind === 'offer_expired'
            ? t('takenAway.offerExpired')
            : t('takenAway.other');

  return (
    <div
      role="status"
      className="mb-4 rounded-2xl border border-warning/40 bg-warning/10 px-4 py-3 text-sm"
    >
      <p className="font-semibold">{t('takenAway.title', { orderNumber: notice.orderNumber })}</p>
      <p className="mt-0.5 text-xs text-muted-foreground">{what}</p>
      {/* Typed by a person (staff) — shown exactly as written. */}
      {notice.endReason && (
        <p className="mt-1 text-xs italic text-muted-foreground">“{notice.endReason}”</p>
      )}
      <Button variant="outline" size="sm" className="mt-2.5" onClick={onDismiss}>
        {t('takenAway.gotIt')}
      </Button>
    </div>
  );
}

// These English strings are SENT to the server and stored as delivery_assignments.end_reason,
// which the merchant's board and the diner's cancelled card print. They stay English whatever
// language the rider reads; only the label on the chip is translated (REASON_LABEL_KEYS).
const PRE_PICKUP_REASONS = ['Vehicle problem', 'Personal emergency', 'Wait at restaurant too long'];
const AT_DOOR_REASONS = ['Customer unreachable', "Can't find the address", 'Customer refused the order'];
/** Kept out of the arrays above because it is not a reason — it is the promise of one. The
 *  word "Other" used to be sent verbatim as the cancellation reason and shown to nobody. */
const OTHER = 'Other';
/** Stored reason → its label key under active.issue.reasons. */
const REASON_LABEL_KEYS: Record<string, string> = {
  'Vehicle problem': 'vehicleProblem',
  'Personal emergency': 'personalEmergency',
  'Wait at restaurant too long': 'waitTooLong',
  'Customer unreachable': 'customerUnreachable',
  "Can't find the address": 'cantFindAddress',
  'Customer refused the order': 'customerRefused',
  [OTHER]: 'other',
};
/** Matches the server-side cap in driver_cancel_delivery / fail_delivery. */
const REASON_MAX = 300;

/** driver_cancel_delivery / fail_delivery raise bare codes; name the ones a rider can act on. */
function issueErrorMessage(raw: string, t: ActiveT): string {
  if (raw.includes('not_cancellable')) return t('issue.errors.notCancellable');
  if (raw.includes('not_failable')) return t('issue.errors.notFailable');
  if (raw.includes('forbidden')) return t('errors.forbidden');
  return t('issue.errors.generic');
}

function DeliveryIssuePanel({ active }: { active: ActiveDeliveryUI }) {
  const t = useTranslations('active');
  const { clearActive } = useDelivery();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<string | null>(null);
  const [otherText, setOtherText] = React.useState('');
  const [photoUrl, setPhotoUrl] = React.useState<string | null>(null);
  const [uploading, setUploading] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);

  // Pre-pickup: releases the job back to dispatch (with a driver cooldown).
  // After pickup: marks the delivery failed and alerts branch staff.
  const prePickup = active.status === 'assigned';
  const reasons = prePickup ? PRE_PICKUP_REASONS : AT_DOOR_REASONS;

  const uploadPhoto = async (file: File) => {
    setUploading(true);
    try {
      const supabase = getBrowserClient();
      const path = `failed/${active.id}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('branch-assets')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      setPhotoUrl(pub.publicUrl);
    } catch (err) {
      console.error('[delivery-issue] photo upload failed', err);
      setError(t('photo.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  // "Other" is only a reason once somebody has typed one. Everything downstream — the
  // rider's own history, the merchant's board, the diner's cancelled card — prints this
  // string, so an empty one is a job nobody can explain afterwards.
  const finalReason = reason === OTHER ? otherText.trim() : (reason ?? '');

  const submit = async () => {
    if (!finalReason) return;
    setSubmitting(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = prePickup
      ? await cancelDelivery(supabase, active.id, finalReason)
      : await failDelivery(supabase, active.id, finalReason, photoUrl);
    setSubmitting(false);
    if (err) {
      console.error('[delivery-issue] submit failed', err.message);
      setError(issueErrorMessage(err.message ?? '', t));
      return;
    }
    // The comment that used to sit here said Realtime would clear the job. It cannot:
    // driver_cancel_delivery nulls deliveries.driver_id, and this app's subscription filters
    // on driver_id=eq.<rider>, which Realtime evaluates against the NEW row — so the rider
    // who just cancelled is the only party guaranteed to receive nothing. The card stayed on
    // screen until the app was next focused. Clear it here.
    clearActive();
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring w-full text-center text-xs font-medium text-muted-foreground underline"
      >
        {t('issue.open')}
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
      <p className="text-sm font-semibold">
        {prePickup ? t('issue.cancelTitle') : t('issue.failTitle')}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {prePickup ? t('issue.cancelHint') : t('issue.failHint')}
      </p>
      <div className="mt-3 space-y-1.5">
        {[...reasons, OTHER].map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input type="radio" name="issue-reason" checked={reason === r} onChange={() => setReason(r)} />
            {t(`issue.reasons.${REASON_LABEL_KEYS[r]}`)}
          </label>
        ))}
      </div>
      {reason === OTHER && (
        <div className="mt-2">
          <label htmlFor="issue-other" className="sr-only">
            {t('issue.otherLabel')}
          </label>
          <textarea
            id="issue-other"
            value={otherText}
            onChange={(e) => setOtherText(e.target.value)}
            rows={3}
            maxLength={REASON_MAX}
            placeholder={t('issue.otherPlaceholder')}
            className="focus-ring w-full rounded-xl border border-border bg-background px-3 py-2 text-sm outline-none"
          />
          <p className="mt-1 text-right text-[11px] text-muted-foreground">
            {otherText.trim().length}/{REASON_MAX}
          </p>
        </div>
      )}
      {!prePickup && (
        <div className="mt-3">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void uploadPhoto(f);
            }}
          />
          {photoUrl ? (
            <p className="flex items-center gap-1.5 text-xs text-success">
              <CheckCircle2 className="h-3.5 w-3.5" /> {t('issue.photoAttached')}
            </p>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="focus-ring text-xs font-medium text-primary underline"
            >
              📸 {uploading ? t('photo.uploading') : t('issue.attachPhoto')}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="md" fullWidth onClick={() => setOpen(false)}>
          {t('issue.keepDelivering')}
        </Button>
        <Button
          variant="danger"
          size="md"
          fullWidth
          onClick={submit}
          loading={submitting}
          disabled={!finalReason}
        >
          {prePickup ? t('issue.cancelDelivery') : t('issue.markFailed')}
        </Button>
      </div>
    </div>
  );
}

// Platform-aware "Navigate" — hands off to the driver's map app of choice and
// launches turn-by-turn where the platform supports it (Android: google.navigation
// deep link → nav starts immediately; iOS: Apple Maps; Waze everywhere).
function NavigateMenu({ lat, lng, address }: { lat: number | null; lng: number | null; address: string }) {
  const t = useTranslations('active');
  const [open, setOpen] = React.useState(false);
  const dest = lat != null && lng != null ? `${lat},${lng}` : null;
  const q = encodeURIComponent(address || '');
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isAndroid = /Android/i.test(ua);

  const go = (kind: 'google' | 'waze' | 'apple') => {
    setOpen(false);
    if (kind === 'waze') {
      window.open(dest ? `https://waze.com/ul?ll=${dest}&navigate=yes` : `https://waze.com/ul?q=${q}&navigate=yes`, '_blank');
      return;
    }
    if (kind === 'apple') {
      window.open(dest ? `https://maps.apple.com/?daddr=${dest}&dirflg=d` : `https://maps.apple.com/?daddr=${q}&dirflg=d`, '_blank');
      return;
    }
    // Google: on Android, google.navigation: starts turn-by-turn straight away.
    if (isAndroid && dest) {
      window.location.href = `google.navigation:q=${dest}&mode=d`;
      return;
    }
    window.open(
      dest ? `https://www.google.com/maps/dir/?api=1&destination=${dest}&travelmode=driving` : `https://maps.google.com/?q=${q}`,
      '_blank',
    );
  };

  return (
    <div className="relative">
      <button
        className="focus-ring inline-flex h-11 items-center gap-1.5 rounded-full bg-card/90 px-4 text-sm font-semibold backdrop-blur"
        aria-label={t('navigate')}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <Navigation className="h-4 w-4" /> {t('navigate')}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-12 z-50 w-44 overflow-hidden rounded-2xl border border-border bg-card shadow-warm" role="menu">
            <NavRow onClick={() => go('google')}>🗺️ Google Maps</NavRow>
            <NavRow onClick={() => go('waze')}>🚗 Waze</NavRow>
            {isIOS && <NavRow onClick={() => go('apple')}>🍎 Apple Maps</NavRow>}
          </div>
        </>
      )}
    </div>
  );
}

function NavRow({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 border-b border-border/60 px-4 py-3 text-left text-sm font-medium last:border-b-0 hover:bg-muted/60"
    >
      {children}
    </button>
  );
}

/** delivery_address.dropoff_pref → its label key under active.dropoff.prefs. */
const DROPOFF_PREF_LABEL_KEYS = {
  leave_at_door: 'leaveAtDoor',
  hand_to_me: 'handToMe',
  at_desk: 'atDesk',
} as const;

// Structured drop-off card for the delivery leg. Orders placed before
// dropoff_pref existed degrade to a notes-only card, or nothing at all.
function DropoffInstructionsCard({ active }: { active: ActiveDeliveryUI }) {
  const t = useTranslations('active');
  const { dropoffPref, dropoffOther, gateCode, room, dropoffNotes } = active;
  if (!dropoffPref && !gateCode && !room && !dropoffNotes) return null;
  const prefLabel =
    dropoffPref === 'other'
      ? dropoffOther
        ? t('dropoff.otherWithText', { text: dropoffOther })
        : t('dropoff.other')
      : dropoffPref
        ? t(`dropoff.prefs.${DROPOFF_PREF_LABEL_KEYS[dropoffPref]}`)
        : null;
  return (
    <div className="rounded-2xl border-2 border-primary/40 bg-primary/10 p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-primary">
        📍 {t('dropoff.title')}
      </p>
      {prefLabel && (
        <p className="mt-1 font-display text-lg font-bold leading-tight">{prefLabel}</p>
      )}
      {(gateCode || room || dropoffNotes) && (
        <div className="mt-1.5 space-y-1 text-sm">
          {gateCode && (
            <p>
              <span className="font-semibold">{t('dropoff.gateCode')}</span> {gateCode}
            </p>
          )}
          {room && (
            <p>
              <span className="font-semibold">{t('dropoff.room')}</span> {room}
            </p>
          )}
          {dropoffNotes && (
            <p>
              <span className="font-semibold">{t('dropoff.note')}</span> {dropoffNotes}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function Step({
  done,
  icon,
  title,
  primary,
  secondary,
}: {
  done: boolean;
  icon: React.ReactNode;
  title: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className={`flex items-start gap-3 ${done ? 'opacity-60' : ''}`}>
      <div
        className={`grid h-11 w-11 shrink-0 place-items-center rounded-2xl ${
          done ? 'bg-success text-white' : 'bg-primary text-primary-foreground'
        }`}
      >
        {done ? <CheckCircle2 className="h-5 w-5" /> : icon}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="font-display text-base font-semibold leading-tight">{primary}</p>
        <p className="text-sm text-muted-foreground">{secondary}</p>
      </div>
    </div>
  );
}
