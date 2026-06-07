'use client';

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { Bike, CheckCircle2, Coffee, MapPin, Navigation, Package, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { Button, Card, EmptyState } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { useDelivery, type ActiveDeliveryUI } from '@/components/delivery-provider';
import type { DeliveryStatus } from '@favornoms/database/queries';

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
  const { active, progress } = useDelivery();

  // Local soft stage for transitions that don't map to a DB status change
  // (e.g. "I'm at the restaurant" is a UI-only step; only "Picked up" changes the row).
  const [softStage, setSoftStage] = React.useState<StageKey>('heading_to_pickup');

  React.useEffect(() => {
    if (!active) {
      setSoftStage('heading_to_pickup');
      return;
    }
    // Sync soft stage with server-side status on mount/refresh
    if (active.status === 'picked_up') setSoftStage('picked_up');
    else if (active.status === 'in_transit') setSoftStage('in_transit');
    else if (active.status === 'assigned') {
      setSoftStage((prev) => (prev === 'at_pickup' ? 'at_pickup' : 'heading_to_pickup'));
    }
  }, [active]);

  if (!active) {
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

  const handleAdvance = () => {
    if ('vibrate' in navigator) navigator.vibrate(40);
    if (meta.transition) {
      void progress(meta.transition);
    } else if (meta.nextStage) {
      setSoftStage(meta.nextStage);
    }
  };

  const isHeading = stage === 'heading_to_pickup' || stage === 'at_pickup';
  const isInTransit = stage === 'picked_up' || stage === 'in_transit' || stage === 'at_customer';

  return (
    <div className="relative">
      <section className="relative h-[42vh] overflow-hidden bg-muted">
        <div className="absolute inset-0 bg-gradient-to-b from-primary/10 via-transparent to-card/80" />
        <svg viewBox="0 0 400 400" className="absolute inset-0 h-full w-full">
          <defs>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="hsl(var(--border))" strokeWidth="0.5" />
            </pattern>
            <linearGradient id="route" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="hsl(var(--primary))" />
              <stop offset="100%" stopColor="hsl(var(--accent))" />
            </linearGradient>
          </defs>
          <rect width="400" height="400" fill="url(#grid)" />
          <motion.path
            d="M 80 320 C 160 240, 240 280, 340 80"
            fill="none"
            stroke="url(#route)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray="10 8"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 1.6, ease: 'easeInOut' }}
          />
          <circle cx="80" cy="320" r="12" fill="hsl(var(--primary))" />
          <circle cx="340" cy="80" r="12" fill="hsl(var(--accent))" />
          <motion.circle
            r="14"
            fill="white"
            stroke="hsl(var(--primary))"
            strokeWidth="4"
            animate={{ cx: [80, 200, 340], cy: [320, 220, 80] }}
            transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
          />
        </svg>

        <div className="absolute left-4 right-4 top-4 flex items-center justify-between">
          <span className="rounded-full bg-card/90 px-3 py-1.5 text-xs font-semibold backdrop-blur">
            {active.distanceKm.toFixed(1)} km · {active.estimatedDurationMin} min
          </span>
          <button
            className="focus-ring inline-flex h-11 items-center gap-1.5 rounded-full bg-card/90 px-4 text-sm font-semibold backdrop-blur"
            aria-label={t('navigate')}
            onClick={() => {
              const target = isHeading
                ? encodeURIComponent(active.branchAddress)
                : encodeURIComponent(active.customerAddress);
              if (target) window.open(`https://maps.google.com/?q=${target}`, '_blank');
            }}
          >
            <Navigation className="h-4 w-4" /> {t('navigate')}
          </button>
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

            <div className="flex items-center justify-between rounded-2xl bg-muted/40 px-4 py-3">
              <div>
                <p className="text-xs text-muted-foreground">Earning</p>
                <p className="font-display text-xl font-bold text-primary">
                  {formatCurrency(active.driverEarnings)}
                </p>
              </div>
              {active.customerPhone && (
                <a href={`tel:${active.customerPhone}`}>
                  <Button variant="soft" leftIcon={<Phone className="h-4 w-4" />} size="md">
                    {t('callCustomer')}
                  </Button>
                </a>
              )}
            </div>

            {stage === 'at_customer' && (
              <PodUploader deliveryId={active.id} />
            )}
            <Button variant="gradient" size="xl" fullWidth onClick={handleAdvance}>
              {t(meta.ctaKey as never)}
            </Button>
          </div>
        </Card>
      </section>
    </div>
  );
}

function PodUploader({ deliveryId }: { deliveryId: string }) {
  const [uploading, setUploading] = React.useState(false);
  const [uploaded, setUploaded] = React.useState<string | null>(null);
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
      setUploaded(pub.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rounded-2xl border border-dashed border-border bg-muted/40 p-3">
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
        }}
      />
      {uploaded ? (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" /> Delivery photo uploaded
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="focus-ring flex w-full items-center justify-center gap-2 rounded-xl bg-card px-4 py-2 text-sm font-semibold"
        >
          📸 {uploading ? 'Uploading…' : 'Snap a delivery photo (proof of delivery)'}
        </button>
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
