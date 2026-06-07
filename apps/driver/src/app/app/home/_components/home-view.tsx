'use client';

import * as React from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { Battery, CalendarDays, ChevronRight, Coffee, MapPin, Power, Star, Store, Wallet, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { setDriverOnline } from '@favornoms/database/queries';
import { Card, cn } from '@favornoms/ui';
import { useDriver } from '@/store/driver';
import { useDriverSession } from '@/components/driver-session';
import { useDelivery } from '@/components/delivery-provider';
import { DispatchSheet } from '@/components/dispatch-sheet';

export function HomeView() {
  const t = useTranslations('home');
  const { driver } = useDriverSession();
  const status = useDriver((s) => s.status);
  const toggle = useDriver((s) => s.toggle);
  const setStatus = useDriver((s) => s.setStatus);
  const { offered, active, accept, reject } = useDelivery();

  // Reflect "on delivery" into local store so the location ping keeps running
  React.useEffect(() => {
    if (active && status !== 'on_delivery') setStatus('on_delivery');
    if (!active && status === 'on_delivery') setStatus('online');
  }, [active, status, setStatus]);

  // Vibrate when a new offer arrives
  const offeredId = offered?.id;
  React.useEffect(() => {
    if (offeredId && 'vibrate' in navigator) navigator.vibrate([200, 100, 200]);
  }, [offeredId]);

  const isOnline = status === 'online' || status === 'on_delivery';
  const approvedCount = driver.approvals?.filter((a) => a.status === 'approved').length ?? 0;

  const handleToggle = async () => {
    const next = isOnline ? 'offline' : 'online';
    toggle();
    if ('vibrate' in navigator) navigator.vibrate(40);
    const supabase = getBrowserClient();
    await setDriverOnline(supabase, driver.id, next === 'online');
  };

  return (
    <div className="relative">
      {/* Hero */}
      <section className="relative isolate overflow-hidden rounded-b-3xl pb-16 pt-safe shadow-warm">
        {/* Background layers (paint back → front) */}
        <div className="absolute inset-0 bg-gradient-to-br from-stone-800 via-stone-900 to-stone-950" />
        <div className="absolute inset-0 bg-gradient-sunset" />
        <div
          className={cn(
            'absolute inset-0 bg-gradient-warm transition-opacity duration-700',
            isOnline ? 'opacity-100' : 'opacity-0',
          )}
        />
        <div className="absolute inset-0 bg-noise opacity-20" />

        {/* Content */}
        <div className="relative z-10 px-5 pt-6 text-center text-white">
          {driver.battery_level != null && (
            <div className="absolute right-5 top-6 flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 text-xs font-semibold ring-1 ring-white/20 backdrop-blur">
              <Battery className="h-4 w-4" />
              {driver.battery_level}%
            </div>
          )}
          <p className="text-sm font-medium text-white/75">
            Hey {driver.full_name.split(' ')[0]} 👋
          </p>
          <h1 className="mt-1 font-display text-3xl font-bold leading-tight drop-shadow-sm">
            {isOnline ? t('statusOnline') : t('statusOffline')}
          </h1>
          <p className="mt-1.5 text-sm text-white/80">
            {isOnline ? t('readyToReceive') : t('subOffline')}
          </p>

          <div className="mt-10 flex justify-center">
            <PowerButton
              online={isOnline}
              onClick={handleToggle}
              label={isOnline ? t('goOffline') : t('goOnline')}
            />
          </div>

          <div className="mt-14 flex justify-center">
            <StatusPill online={isOnline} label={isOnline ? t('online') : t('offline')} />
          </div>
        </div>
      </section>

      {/* Stats — floats on top of the hero's rounded base */}
      <section className="relative z-10 -mt-8 px-4">
        <Card className="grid grid-cols-3 divide-x divide-border/70 bg-card p-1 shadow-warm">
          <Stat icon={<Wallet className="h-4 w-4" />} label={t('today')} value={formatCurrency(0)} />
          <Stat
            icon={<CalendarDays className="h-4 w-4" />}
            label={t('week')}
            value={formatCurrency(0)}
          />
          <Stat
            icon={<Star className="h-4 w-4 fill-accent text-accent" />}
            label={t('rating')}
            value={(driver.average_rating ?? 0).toFixed(1)}
          />
        </Card>
      </section>

      {/* Apply to restaurants */}
      <section className="mt-6 px-4">
        <Link href="/app/apply" className="focus-ring block rounded-2xl">
          <Card className="flex items-center gap-3 p-4">
            <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
              <Store className="h-5 w-5" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="font-semibold">Apply to restaurants</p>
              <p className="text-sm text-muted-foreground">
                {approvedCount > 0
                  ? `${approvedCount} approved · tap to add more`
                  : 'Get approved to start receiving orders'}
              </p>
            </div>
            <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
          </Card>
        </Link>
      </section>

      <section className="mt-6 px-4">
        <PerformanceCard />
      </section>

      <section className="mt-6 px-4">
        <Card className="overflow-hidden">
          <div className="border-b border-border/40 bg-gradient-to-r from-accent/20 to-primary/10 px-5 py-4">
            <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
              <Zap className="h-5 w-5 text-accent-foreground" />
              {t('tips')}
            </h2>
          </div>
          <ul className="space-y-1 p-5">
            {[t('tip1'), t('tip2'), t('tip3')].map((tip, i) => (
              <li key={i} className="flex items-start gap-3 py-2">
                <div className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                  {i + 1}
                </div>
                <p className="text-sm text-foreground">{tip}</p>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="mt-6 px-4">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('lastDispatch')}</h2>
          <div className="mt-3 flex items-start gap-3">
            <div className="grid h-10 w-10 place-items-center rounded-xl bg-success/15 text-success">
              <Coffee className="h-5 w-5" />
            </div>
            <div className="flex-1">
              <p className="font-semibold">{active ? active.branchName : '—'}</p>
              <p className="text-sm text-muted-foreground">
                {active
                  ? `${active.itemsSummary} · ${active.distanceKm.toFixed(1)} km · ${formatCurrency(active.driverEarnings)}`
                  : 'No deliveries yet'}
              </p>
            </div>
            <MapPin className="h-5 w-5 text-muted-foreground" />
          </div>
        </Card>
      </section>

      <AnimatePresence>
        {offered && (
          <DispatchSheet
            offer={offered}
            timeoutSeconds={45}
            onAccept={() => {
              void accept();
            }}
            onReject={() => {
              void reject('declined');
            }}
            onTimeout={() => {
              void reject('timeout');
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function PowerButton({
  online,
  onClick,
  label,
}: {
  online: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <motion.button
      whileTap={{ scale: 0.94 }}
      onClick={onClick}
      className="focus-ring relative grid h-44 w-44 place-items-center rounded-full"
      aria-label={label}
    >
      <span
        className={cn(
          'absolute inset-0 rounded-full transition-all duration-500',
          online
            ? 'bg-white/20 shadow-[0_0_70px_rgba(255,255,255,0.45)] backdrop-blur'
            : 'bg-white/10 backdrop-blur',
        )}
      />
      {online && (
        <>
          <span className="absolute inset-2 animate-pulse-ring rounded-full bg-white/30" />
          <span
            className="absolute inset-2 animate-pulse-ring rounded-full bg-white/20"
            style={{ animationDelay: '0.6s' }}
          />
        </>
      )}
      <span
        className={cn(
          'relative grid h-32 w-32 place-items-center rounded-full ring-1 transition-all duration-300',
          online
            ? 'bg-white text-primary shadow-warm ring-white/60'
            : 'bg-white text-stone-700 shadow-lg ring-white/30',
        )}
      >
        <Power className="h-14 w-14" strokeWidth={2.5} />
      </span>
      <span className="absolute -bottom-9 whitespace-nowrap font-display text-base font-bold text-white drop-shadow">
        {label}
      </span>
    </motion.button>
  );
}

function StatusPill({ online, label }: { online: boolean; label: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold ring-1 backdrop-blur',
        online
          ? 'bg-success text-white shadow-warm ring-white/30'
          : 'bg-white/15 text-white ring-white/25',
      )}
    >
      <span className="relative flex h-2.5 w-2.5">
        <span
          className={cn(
            'absolute inset-0 animate-pulse-ring rounded-full',
            online ? 'bg-white' : 'bg-white/50',
          )}
        />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-white" />
      </span>
      {label}
    </span>
  );
}

function Stat({
  icon,
  label,
  value,
}: {
  icon?: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-1 px-2 py-4 text-center">
      {icon && <span className="text-muted-foreground">{icon}</span>}
      <p className="font-display text-xl font-bold text-foreground">{value}</p>
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
    </div>
  );
}

interface DriverStats {
  days: number;
  assigned: number;
  accepted: number;
  completed: number;
  acceptance_rate: number | null;
  on_time_rate: number | null;
  avg_rating: number | null;
  total_earnings_usd: number;
}

function PerformanceCard() {
  const [stats, setStats] = React.useState<DriverStats | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase.rpc('get_my_driver_stats', { p_days: 30 });
      if (!cancelled && data && !(data as { error?: string }).error) {
        setStats(data as DriverStats);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  if (!stats) return null;

  return (
    <Card className="p-5">
      <h2 className="font-display text-lg font-semibold">Last 30 days</h2>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile label="Deliveries" value={String(stats.completed)} />
        <Tile label="Earnings" value={formatCurrency(stats.total_earnings_usd)} />
        <Tile
          label="Acceptance"
          value={stats.acceptance_rate != null ? `${stats.acceptance_rate}%` : '—'}
        />
        <Tile
          label="On-time"
          value={stats.on_time_rate != null ? `${stats.on_time_rate}%` : '—'}
        />
      </div>
    </Card>
  );
}

function Tile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl bg-muted/40 p-3 text-center">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 font-display text-lg font-bold">{value}</p>
    </div>
  );
}
