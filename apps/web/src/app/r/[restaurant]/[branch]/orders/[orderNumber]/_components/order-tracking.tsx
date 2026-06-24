'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Bike, ChefHat, CheckCircle2, ChevronLeft, MapPin, Phone, Receipt } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { DeliveryMap, fetchRoute, hasMapboxToken, type LatLng } from '@favornoms/maps';
import { Badge, Button, Card, IconButton } from '@favornoms/ui';
import { DeliveryChat } from './delivery-chat';
import { OrderActions } from './order-actions';

const steps = [
  { key: 'confirmed', icon: CheckCircle2 },
  { key: 'preparing', icon: ChefHat },
  { key: 'ready', icon: Receipt },
  { key: 'out_for_delivery', icon: Bike },
  { key: 'completed', icon: MapPin },
] as const;

type OrderRow = {
  id: string;
  order_number: string;
  status: string;
  channel: string;
  total: number | string;
  customer_name?: string | null;
  customer_phone?: string | null;
  created_at: string;
  order_items: Array<{ item_name: string; quantity: number }>;
  deliveries: Array<{
    id: string;
    status: string;
    driver_id: string | null;
    distance_km: number | null;
    estimated_duration_min: number | null;
    accepted_at?: string | null;
    driver_lat?: number | null;
    driver_lng?: number | null;
    current_eta_min?: number | null;
    arriving_at?: string | null;
    dropoff_lat?: number | null;
    dropoff_lng?: number | null;
  }>;
};

interface Props {
  initialOrder: OrderRow;
  branchId: string;
  branchLocation?: { lat: number; lng: number } | null;
}

export function OrderTracking({ initialOrder, branchId, branchLocation }: Props) {
  const t = useTranslations('tracking');
  const router = useRouter();
  const pathname = usePathname();
  const [order, setOrder] = React.useState<OrderRow>(initialOrder);

  // Realtime subscribe
  React.useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`order:${order.id}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${order.id}` },
        (payload) => {
          setOrder((curr) => ({ ...curr, ...(payload.new as Partial<OrderRow>) }));
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deliveries', filter: `order_id=eq.${order.id}` },
        (payload) => {
          setOrder((curr) => ({
            ...curr,
            deliveries: payload.new ? [payload.new as OrderRow['deliveries'][number]] : curr.deliveries,
          }));
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [order.id]);

  // Find current step by status
  const statusIndex = React.useMemo(() => {
    // 'delivered' is a terminal delivery status with no distinct step — map it to the final
    // 'completed' step so a just-delivered order doesn't snap the bar back to step 1.
    const key = order.status === 'delivered' ? 'completed' : order.status;
    const idx = steps.findIndex((s) => s.key === key);
    // 'pending' (pre-confirm) shows step 0 grey, fall back to 0
    return Math.max(idx, 0);
  }, [order.status]);

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
  const showMap =
    !!liveDelivery && !!branchLocation && (branchLocation.lat !== 0 || branchLocation.lng !== 0) && hasMapboxToken();
  const etaMin = delivery?.current_eta_min ?? delivery?.estimated_duration_min ?? null;
  const arriving = !!delivery?.arriving_at;

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
          <TrackingMap branch={branchLocation} delivery={liveDelivery} arriving={arriving} />
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
                  {t('statuses.' + (steps[statusIndex]?.key ?? 'confirmed') as never)}
                </p>
                <h2 className="mt-1 font-display text-2xl font-bold leading-tight">
                  {order.order_items.map((i) => `${i.quantity}× ${i.item_name}`).join(', ')}
                </h2>
              </div>
            </div>
          </div>
        )}

        <div className="px-5 pb-5 pt-6">
          <ol className="relative grid grid-cols-5 gap-2">
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
                    {t('statuses.' + step.key as never)}
                  </span>
                </li>
              );
            })}
          </ol>

          {order.status === 'pending' && <StripePayment orderId={order.id} />}

          {delivery?.driver_id && (
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
                    {arriving ? 'Your driver is almost there!' : 'Your driver is on the way'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {delivery.distance_km != null && `${kmToMi(delivery.distance_km).toFixed(1)} mi · `}
                    {etaMin != null && `${etaMin} min ETA`}
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <DeliveryChat deliveryId={delivery.id} deliveryStatus={delivery.status} />
                <CallDriverButton deliveryId={delivery.id} label={t('callDriver')} />
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
          orderId={order.id}
          branchId={branchId}
          orderStatus={order.status}
          hasRating={false}
          hasDriver={!!delivery?.driver_id}
        />
      </div>
    </div>
  );
}

function TrackingMap({
  branch,
  delivery,
  arriving,
}: {
  branch: LatLng;
  delivery: OrderRow['deliveries'][number];
  arriving: boolean;
}) {
  const dropoff =
    delivery.dropoff_lat != null && delivery.dropoff_lng != null
      ? { lat: delivery.dropoff_lat, lng: delivery.dropoff_lng }
      : null;
  const driver =
    delivery.driver_lat != null && delivery.driver_lng != null
      ? { lat: delivery.driver_lat, lng: delivery.driver_lng }
      : null;
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
        className="h-full w-full"
      />
      {arriving && (
        <span className="absolute left-3 top-3 z-10 rounded-full bg-success px-3 py-1.5 text-xs font-bold text-white shadow-lg">
          🛵 Arriving now
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

function StripePayment({ orderId }: { orderId: string }) {
  const [stage, setStage] = React.useState<'idle' | 'loading' | 'ready' | 'paying' | 'mock' | 'error'>('idle');
  const [error, setError] = React.useState<string | null>(null);
  const [clientSecret, setClientSecret] = React.useState<string | null>(null);
  const [publishableKey, setPublishableKey] = React.useState<string | null>(null);

  const publicKeyEnv = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;

  const initStripe = async () => {
    setStage('loading');
    setError(null);
    try {
      const supabase = getBrowserClient();
      const { createStripePaymentIntent } = await import('@favornoms/database/queries');
      const intent = await createStripePaymentIntent(supabase, orderId);
      setClientSecret(intent.client_secret);
      setPublishableKey(intent.publishable_key ?? publicKeyEnv ?? null);
      setStage('ready');
    } catch (err) {
      const msg = (err as Error).message;
      if (msg.includes('stripe_not_configured')) {
        // Demo / dev: no Stripe keys set. Allow a one-click mock confirm.
        setStage('mock');
        return;
      }
      setError(msg);
      setStage('error');
    }
  };

  const confirmStripe = async () => {
    if (!clientSecret || !publishableKey) return;
    setStage('paying');
    setError(null);
    try {
      const stripe = await loadStripe(publishableKey);
      // Use redirect-less confirmation with a placeholder card. In a real
      // implementation we'd mount Stripe Elements; this is a minimal flow.
      const result = await stripe.confirmCardPayment(clientSecret);
      if (result.error) {
        setError(result.error.message ?? 'Payment failed');
        setStage('ready');
        return;
      }
      // Server-side webhook will flip order → confirmed; client sees via realtime.
    } catch (err) {
      setError((err as Error).message);
      setStage('ready');
    }
  };

  const mockConfirm = async () => {
    setStage('paying');
    const supabase = getBrowserClient();
    await supabase.from('payments').update({ status: 'completed', paid_at: new Date().toISOString() }).eq('order_id', orderId);
    await supabase.from('orders').update({ status: 'confirmed' }).eq('id', orderId);
  };

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      className="mt-6 rounded-2xl border border-warning/40 bg-warning/5 p-4"
    >
      <p className="text-sm font-semibold text-warning">Payment pending</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Pay securely via Stripe. We never store your card details.
      </p>
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
      {stage === 'idle' && (
        <Button variant="gradient" size="md" fullWidth className="mt-3" onClick={initStripe}>
          Pay with card
        </Button>
      )}
      {stage === 'loading' && (
        <Button variant="gradient" size="md" fullWidth className="mt-3" loading>
          Loading…
        </Button>
      )}
      {stage === 'ready' && (
        <Button variant="gradient" size="md" fullWidth className="mt-3" onClick={confirmStripe}>
          Confirm payment
        </Button>
      )}
      {stage === 'paying' && (
        <Button variant="gradient" size="md" fullWidth className="mt-3" loading>
          Processing…
        </Button>
      )}
      {stage === 'mock' && (
        <div className="mt-3 space-y-2">
          <p className="text-xs text-muted-foreground">
            Stripe is not configured on this environment. Use the demo confirm button to mark the
            order paid for local testing.
          </p>
          <Button variant="gradient" size="md" fullWidth onClick={mockConfirm}>
            Mock confirm (dev only)
          </Button>
        </div>
      )}
      {stage === 'error' && (
        <Button variant="outline" size="md" fullWidth className="mt-3" onClick={initStripe}>
          Try again
        </Button>
      )}
    </motion.div>
  );
}

// Dynamically load Stripe.js from CDN. Avoids an npm dep at build-time.
async function loadStripe(publishableKey: string) {
  if (typeof window === 'undefined') throw new Error('client_only');
  type StripeFn = (key: string) => {
    confirmCardPayment: (secret: string) => Promise<{ error?: { message?: string }; paymentIntent?: { status: string } }>;
  };
  const w = window as unknown as { Stripe?: StripeFn };
  if (!w.Stripe) {
    await new Promise<void>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://js.stripe.com/v3/';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('stripe_js_load_failed'));
      document.head.appendChild(s);
    });
  }
  if (!w.Stripe) throw new Error('stripe_js_missing');
  return w.Stripe(publishableKey);
}
