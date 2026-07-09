'use client';

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Bike, CheckCircle2, Coffee, MapPin, Navigation, Package, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { Button, Card, EmptyState } from '@favornoms/ui';
import { DeliveryMap, fetchRoute, hasMapboxToken } from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';
import { useDelivery, type ActiveDeliveryUI } from '@/components/delivery-provider';
import { cancelDelivery, failDelivery, type DeliveryStatus } from '@favornoms/database/queries';
import { DriverDeliveryChat } from './delivery-chat';

type StageKey = 'heading_to_pickup' | 'at_pickup' | 'picked_up' | 'in_transit' | 'at_customer';

const stageMeta: Record<
  StageKey,
  {
    titleKey: string;
    ctaKey: string;
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
  picked_up: {
    titleKey: 'pickedUp',
    ctaKey: 'atCustomer',
    icon: Bike,
    color: 'from-accent to-primary',
    transition: 'in_transit',
  },
  in_transit: {
    titleKey: 'pickedUp',
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
  const { active, progress, markArriving } = useDelivery();
  const [advancing, setAdvancing] = React.useState(false);
  const [driverPos, setDriverPos] = React.useState<{ lat: number; lng: number } | null>(null);
  const [geoDenied, setGeoDenied] = React.useState(false);
  const [route, setRoute] = React.useState<[number, number][] | null>(null);
  const [completed, setCompleted] = React.useState<{ earnings: number; orderNumber: string } | null>(null);
  const [advanceError, setAdvanceError] = React.useState<string | null>(null);
  // Local echoes of the just-uploaded proof photos for instant CTA-unlock
  // (the provider also picks them up from the server on its next realtime resync).
  const [pickupPhotoUrl, setPickupPhotoUrl] = React.useState<string | null>(null);
  const [podPhotoUrl, setPodPhotoUrl] = React.useState<string | null>(null);

  // Reset the local echoes when the active job changes.
  React.useEffect(() => {
    setPickupPhotoUrl(null);
    setPodPhotoUrl(null);
  }, [active?.id]);

  // Watch GPS for the live route map (separate from DriverLocationPing's DB push) +
  // surface a permission-denied state so the driver isn't silently invisible.
  React.useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setDriverPos({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setGeoDenied(false);
      },
      (err) => {
        if (err.code === err.PERMISSION_DENIED) setGeoDenied(true);
      },
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 15_000 },
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

  // Local soft stage for transitions that don't map to a DB status change
  // (e.g. "I'm at the restaurant" is a UI-only step; only "Picked up" changes the row).
  const [softStage, setSoftStage] = React.useState<StageKey>('heading_to_pickup');

  React.useEffect(() => {
    if (!active) {
      setSoftStage('heading_to_pickup');
      return;
    }
    // Sync soft stage with server-side status on mount/refresh. Preserve the local
    // "arrived" sub-steps (at_pickup / at_customer) so a realtime resync — e.g. the
    // one markArriving() triggers — doesn't yank the driver back a step.
    if (active.status === 'picked_up') setSoftStage('picked_up');
    else if (active.status === 'in_transit') {
      setSoftStage((prev) => (prev === 'at_customer' ? 'at_customer' : 'in_transit'));
    } else if (active.status === 'assigned') {
      setSoftStage((prev) => (prev === 'at_pickup' ? 'at_pickup' : 'heading_to_pickup'));
    }
  }, [active]);

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
            <h1 className="mt-5 font-display text-2xl font-bold">Delivery complete! 🎉</h1>
            <p className="mt-1 text-sm text-muted-foreground">{completed.orderNumber}</p>
            <div className="mt-5 rounded-2xl bg-muted/50 px-5 py-4">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">Earnings added</p>
              <p className="font-display text-3xl font-bold text-primary">
                {formatCurrency(completed.earnings)}
              </p>
            </div>
            <Link href="/app/home" className="mt-6 block">
              <Button variant="gradient" size="xl" fullWidth onClick={() => setCompleted(null)}>
                Find next order
              </Button>
            </Link>
          </motion.div>
        </div>
      );
    }
    return (
      <div className="px-4 pt-6">
        <EmptyState
          icon={<Navigation className="h-7 w-7" />}
          title={t('noActive')}
          description={t('noActiveDescription')}
          action={
            <Link href="/app/home">
              <Button variant="gradient" size="lg">
                Go home
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
  const hasPickupPhoto = !!pickupPhotoUrl || !!active.pickupPhotoUrl;
  const needsPickupPhoto = stage === 'at_pickup' && !hasPickupPhoto;
  // Proof of delivery is mandatory: at the customer the driver must snap a photo
  // before "Mark as delivered" unlocks.
  const hasPodPhoto = !!podPhotoUrl || !!active.podPhotoUrl;
  const needsPodPhoto = stage === 'at_customer' && !hasPodPhoto;

  const handleAdvance = async () => {
    if (advancing) return; // guard against double-fire
    // Belt-and-braces: the CTA is already disabled, but never advance to picked_up
    // without the pickup photo, nor finish without the delivery photo
    // (progress_delivery also enforces both server-side).
    if (meta.transition === 'picked_up' && !hasPickupPhoto) {
      setAdvanceError('Take a pickup photo before you continue.');
      return;
    }
    if (meta.transition === 'delivered' && !hasPodPhoto) {
      setAdvanceError('Take a delivery photo before you finish.');
      return;
    }
    if ('vibrate' in navigator) navigator.vibrate(40);
    setAdvancing(true);
    setAdvanceError(null);
    try {
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
      } else if (meta.transition) {
        await progress(meta.transition);
      } else if (meta.nextStage) {
        // Soft UI-only step. If it's "arrived at the customer", also persist arriving_at
        // so the customer gets the "arriving now" push + map badge.
        if (meta.nextStage === 'at_customer') await markArriving();
        setSoftStage(meta.nextStage);
      }
    } catch {
      // Server rejected the step (already resynced by progress()). Surface it instead
      // of optimistically advancing or faking a completion.
      setAdvanceError("Couldn't update this delivery — please try again.");
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
              {hasMapboxToken() ? 'Live map unavailable for this order.' : 'Map unavailable'}
            </p>
          </div>
        )}

        <div className="pointer-events-none absolute left-4 right-4 top-4 flex items-center justify-between [&>*]:pointer-events-auto">
          <span className="rounded-full bg-card/90 px-3 py-1.5 text-xs font-semibold backdrop-blur">
            {kmToMi(active.distanceKm).toFixed(1)} mi · {active.estimatedDurationMin} min
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
                  {active.orderNumber}
                </p>
                <h2 className="font-display text-xl font-bold leading-tight">
                  {t(meta.titleKey as never)}
                </h2>
              </div>
            </div>
          </motion.div>

          <div className="space-y-4 p-5">
            {geoDenied && (
              <div className="rounded-2xl border border-warning/40 bg-warning/10 px-4 py-2.5 text-xs font-medium text-warning">
                📍 Location is off. Turn it on so the customer can track you and you keep receiving
                offers.
              </div>
            )}
            <Step
              done={isInTransit}
              icon={<Coffee className="h-5 w-5" />}
              title="Pickup"
              primary={active.branchName}
              secondary={active.branchAddress}
            />
            <Step
              done={stage === 'at_customer'}
              icon={<MapPin className="h-5 w-5" />}
              title="Drop-off"
              primary={active.customerName}
              secondary={active.customerAddress}
            />

            {active.dropoffNotes && (
              <div className="rounded-2xl border border-primary/30 bg-primary/5 px-4 py-2.5 text-sm">
                <span className="font-semibold">📍 Delivery note:</span> {active.dropoffNotes}
              </div>
            )}

            <div className="flex items-center justify-between rounded-2xl bg-muted/40 px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">Earning</p>
                <p className="font-display text-xl font-bold text-primary">
                  {formatCurrency(active.driverEarnings)}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <DriverDeliveryChat deliveryId={active.id} deliveryStatus={active.status} />
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
              <PickupPhotoUploader
                deliveryId={active.id}
                uploadedUrl={pickupPhotoUrl ?? active.pickupPhotoUrl}
                onUploaded={setPickupPhotoUrl}
              />
            )}
            {stage === 'at_customer' && (
              <PodUploader
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
              disabled={advancing || needsPickupPhoto || needsPodPhoto}
            >
              {t(meta.ctaKey as never)}
            </Button>
            {needsPickupPhoto && (
              <p className="text-center text-xs text-muted-foreground">
                📸 Upload a pickup photo to continue.
              </p>
            )}
            {needsPodPhoto && (
              <p className="text-center text-xs text-muted-foreground">
                📸 Upload a delivery photo to finish.
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

const PRE_PICKUP_REASONS = ['Vehicle problem', 'Personal emergency', 'Wait at restaurant too long', 'Other'];
const AT_DOOR_REASONS = ['Customer unreachable', "Can't find the address", 'Customer refused the order', 'Other'];

function DeliveryIssuePanel({ active }: { active: ActiveDeliveryUI }) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState<string | null>(null);
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
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    if (!reason) return;
    setSubmitting(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = prePickup
      ? await cancelDelivery(supabase, active.id, reason)
      : await failDelivery(supabase, active.id, reason, photoUrl);
    setSubmitting(false);
    if (err) {
      setError(err.message);
      return;
    }
    // Realtime on deliveries clears the active job via the provider.
    setOpen(false);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="focus-ring w-full text-center text-xs font-medium text-muted-foreground underline"
      >
        Having a problem with this delivery?
      </button>
    );
  }

  return (
    <div className="rounded-2xl border border-danger/30 bg-danger/5 p-4">
      <p className="text-sm font-semibold">
        {prePickup ? 'Cancel this delivery?' : "Can't complete the drop-off?"}
      </p>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {prePickup
          ? 'The job goes back to dispatch and you get a short cooldown.'
          : 'The restaurant will be alerted to sort out the order.'}
      </p>
      <div className="mt-3 space-y-1.5">
        {reasons.map((r) => (
          <label key={r} className="flex items-center gap-2 text-sm">
            <input type="radio" name="issue-reason" checked={reason === r} onChange={() => setReason(r)} />
            {r}
          </label>
        ))}
      </div>
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
              <CheckCircle2 className="h-3.5 w-3.5" /> Photo attached
            </p>
          ) : (
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={uploading}
              className="focus-ring text-xs font-medium text-primary underline"
            >
              📸 {uploading ? 'Uploading…' : 'Attach a photo (recommended)'}
            </button>
          )}
        </div>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      <div className="mt-3 flex gap-2">
        <Button variant="outline" size="md" fullWidth onClick={() => setOpen(false)}>
          Keep delivering
        </Button>
        <Button
          variant="danger"
          size="md"
          fullWidth
          onClick={submit}
          loading={submitting}
          disabled={!reason}
        >
          {prePickup ? 'Cancel delivery' : 'Mark as failed'}
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

function PickupPhotoUploader({
  deliveryId,
  uploadedUrl,
  onUploaded,
}: {
  deliveryId: string;
  uploadedUrl: string | null;
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const path = `pickup/${deliveryId}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('branch-assets')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      const { error: updErr } = await supabase
        .from('deliveries')
        // pickup_photo_url/_at aren't in the generated types yet — escape hatch.
        .update({ pickup_photo_url: pub.publicUrl, pickup_photo_uploaded_at: new Date().toISOString() } as never)
        .eq('id', deliveryId);
      if (updErr) throw updErr;
      onUploaded(pub.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {uploadedUrl ? (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" /> Pickup photo uploaded
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs font-medium">
            📸 Required — snap a photo of the order at the restaurant before you continue.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-card px-4 py-2 text-sm font-semibold"
          >
            {uploading ? 'Uploading…' : 'Take pickup photo'}
          </button>
        </>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PodUploader({
  deliveryId,
  uploadedUrl,
  onUploaded,
}: {
  deliveryId: string;
  uploadedUrl: string | null;
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const path = `pod/${deliveryId}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('branch-assets')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      const { error: updErr } = await supabase
        .from('deliveries')
        .update({ pod_photo_url: pub.publicUrl, pod_uploaded_at: new Date().toISOString() })
        .eq('id', deliveryId);
      if (updErr) throw updErr;
      onUploaded(pub.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
        }}
      />
      {uploadedUrl ? (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" /> Delivery photo uploaded
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs font-medium">
            📸 Required — snap a photo of the delivered order before you finish.
          </p>
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
            className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-card px-4 py-2 text-sm font-semibold"
          >
            {uploading ? 'Uploading…' : 'Take delivery photo'}
          </button>
        </>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
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
