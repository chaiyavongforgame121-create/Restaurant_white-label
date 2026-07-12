'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Battery, CalendarDays, ChevronRight, Coffee, MapPin, Power, Star, Store, Wallet, Zap } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { setDriverAllBranchesOnline, setDriverBranchOnline } from '@favornoms/database/queries';
import { Card, cn } from '@favornoms/ui';
import { useDriver } from '@/store/driver';
import { useDriverSession } from '@/components/driver-session';
import { useDelivery } from '@/components/delivery-provider';
import { DispatchSheet } from '@/components/dispatch-sheet';
import { AvailabilitySheet } from './availability-sheet';

export function HomeView() {
  const t = useTranslations('home');
  const router = useRouter();
  const { driver, refresh: refreshDriver } = useDriverSession();
  const status = useDriver((s) => s.status);
  const setStatus = useDriver((s) => s.setStatus);
  const scope = useDriver((s) => s.scope);
  const setScope = useDriver((s) => s.setScope);
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const { offered, active, accept, reject } = useDelivery();

  const approved = React.useMemo(
    () => (driver.approvals ?? []).filter((a) => a.status === 'approved'),
    [driver.approvals],
  );
  const approvedIds = React.useMemo(() => approved.map((a) => a.branch_id), [approved]);
  // Short label of the restaurants the driver is (or will be) online for.
  const scopeNames = (scope.length ? approved.filter((a) => scope.includes(a.branch_id)) : approved).map(
    (a) => a.branch?.name ?? 'Restaurant',
  );
  const scopeLabel =
    scopeNames.length === 0
      ? ''
      : scopeNames.length === 1
        ? scopeNames[0]
        : `${scopeNames[0]} +${scopeNames.length - 1}`;

  // Real today / week earnings for the hero stat tiles (was hardcoded $0).
  const [earnings, setEarnings] = React.useState<{ today: number; week: number } | null>(null);
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const supabase = getBrowserClient();
      const [d1, d7] = await Promise.all([
        supabase.rpc('get_my_driver_stats', { p_days: 1 }),
        supabase.rpc('get_my_driver_stats', { p_days: 7 }),
      ]);
      if (cancelled) return;
      const today = (d1.data as { total_earnings_usd?: number } | null)?.total_earnings_usd ?? 0;
      const week = (d7.data as { total_earnings_usd?: number } | null)?.total_earnings_usd ?? 0;
      setEarnings({ today, week });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const [toggling, setToggling] = React.useState(false);
  const [onlineError, setOnlineError] = React.useState(false);

  // Penalty cooldown (D3): while cooldown_until is in the future the driver can't go
  // online. Tick every second so the countdown updates live.
  const cooldownUntilMs = driver.cooldown_until ? new Date(driver.cooldown_until).getTime() : 0;
  const [nowMs, setNowMs] = React.useState(() => Date.now());
  const inCooldown = cooldownUntilMs > nowMs;
  const cooldownRemainingSec = inCooldown ? Math.ceil((cooldownUntilMs - nowMs) / 1000) : 0;
  React.useEffect(() => {
    if (!inCooldown) return;
    const t = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [inCooldown]);

  // Server is the source of truth for online state on load — the persisted store
  // is only a cache and can disagree after reopening on another device or a
  // server-side offline. Reconcile once on mount.
  const reconciledRef = React.useRef(false);
  React.useEffect(() => {
    if (reconciledRef.current) return;
    reconciledRef.current = true;
    if (driver.is_online && status === 'offline') setStatus('online');
    else if (!driver.is_online && status === 'online') setStatus('offline');
  }, [driver.is_online, status, setStatus]);

  // Reflect "on delivery" into local store so the location ping keeps running
  React.useEffect(() => {
    if (active && status !== 'on_delivery') setStatus('on_delivery');
    if (!active && status === 'on_delivery') setStatus('online');
  }, [active, status, setStatus]);

  // Reflect the penalty cooldown into the store status (yields to on_delivery).
  React.useEffect(() => {
    if (status === 'on_delivery') return;
    if (inCooldown && status !== 'cooldown') setStatus('cooldown');
    else if (!inCooldown && status === 'cooldown') setStatus(driver.is_online ? 'online' : 'offline');
  }, [inCooldown, status, setStatus, driver.is_online]);

  // Vibrate when a new offer arrives
  const offeredId = offered?.id;
  React.useEffect(() => {
    if (offeredId && 'vibrate' in navigator) navigator.vibrate([200, 100, 200]);
  }, [offeredId]);

  const isOnline = status === 'online' || status === 'on_delivery';
  const onDelivery = status === 'on_delivery';
  const approvedCount = approved.length;

  // Going online applies to a chosen SET of restaurants (the "scope"): each branch
  // is set individually so an unselected one can't dispatch to this driver. Tapping
  // the button reuses the remembered scope (all approved on first use); the setup
  // sheet lets the driver change which restaurants + set hours.
  const goOnlineFor = async (ids: string[]): Promise<boolean> => {
    if (inCooldown) {
      setOnlineError(true);
      return false;
    }
    const wanted = ids.filter((id) => approvedIds.includes(id));
    const target = new Set(wanted.length ? wanted : approvedIds);
    const prev = status;
    setToggling(true);
    setOnlineError(false);
    setStatus('online'); // optimistic
    if ('vibrate' in navigator) navigator.vibrate(40);
    const supabase = getBrowserClient();
    const results = await Promise.all(
      approved.map((a) => setDriverBranchOnline(supabase, a.branch_id, target.has(a.branch_id))),
    );
    setToggling(false);
    if (results.some((r) => r.error)) {
      setStatus(prev); // roll back so the UI doesn't lie about being online
      setOnlineError(true);
      return false;
    }
    setScope([...target]);
    void refreshDriver(); // re-derive is_online mirror
    return true;
  };

  const goOffline = async () => {
    const prev = status;
    setToggling(true);
    setOnlineError(false);
    setStatus('offline'); // optimistic
    if ('vibrate' in navigator) navigator.vibrate(40);
    const supabase = getBrowserClient();
    const { error } = await setDriverAllBranchesOnline(supabase, false);
    setToggling(false);
    if (error) {
      setStatus(prev);
      setOnlineError(true);
      return;
    }
    void refreshDriver();
  };

  const handleToggle = () => {
    // Never flip while a delivery is in flight or under a penalty cooldown.
    if (toggling || onDelivery || inCooldown) return;
    if (isOnline) void goOffline();
    else void goOnlineFor(scope);
  };

  // Applied from the setup sheet's "Online now" tab.
  const applyFromSheet = async (ids: string[]) => {
    const ok = await goOnlineFor(ids);
    if (ok) setSheetOpen(false);
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

          <div className="mt-8 flex justify-center">
            <PowerButton
              online={isOnline}
              disabled={onDelivery || inCooldown}
              onClick={handleToggle}
              label={
                onDelivery
                  ? t('online')
                  : inCooldown
                    ? `Paused · ${formatCountdown(cooldownRemainingSec)}`
                    : isOnline
                      ? t('goOffline')
                      : t('goOnline')
              }
            />
          </div>

          <p className="mt-10 text-xs text-white/70">
            {isOnline ? (scopeLabel ? `Online for ${scopeLabel}` : 'Online') : 'Tap to go online'}
          </p>
          <div className="mt-3 flex justify-center">
            <StatusPill online={isOnline} label={isOnline ? t('online') : t('offline')} />
          </div>
          {onlineError && (
            <p className="mx-auto mt-3 inline-block rounded-full bg-danger/90 px-4 py-1.5 text-sm font-medium text-white">
              Couldn&apos;t update your status — check your connection and try again.
            </p>
          )}
          {inCooldown && (
            <p className="mx-auto mt-3 inline-block rounded-full bg-white/15 px-4 py-1.5 text-sm font-medium text-white ring-1 ring-white/25">
              Too many declined offers &mdash; you can go back online in {formatCountdown(cooldownRemainingSec)}.
            </p>
          )}
        </div>
      </section>

      {/* Stats — floats on top of the hero's rounded base */}
      <section className="relative z-10 -mt-8 px-4">
        <Card className="grid grid-cols-3 divide-x divide-border/70 bg-card p-1 shadow-warm">
          <Stat icon={<Wallet className="h-4 w-4" />} label={t('today')} value={formatCurrency(earnings?.today ?? 0)} />
          <Stat
            icon={<CalendarDays className="h-4 w-4" />}
            label={t('week')}
            value={formatCurrency(earnings?.week ?? 0)}
          />
          <Stat
            icon={<Star className="h-4 w-4 fill-accent text-accent" />}
            label={t('rating')}
            value={(driver.average_rating ?? 0).toFixed(1)}
          />
        </Card>
      </section>

      {/* Restaurants + hours — opens the unified setup sheet (per-restaurant + schedule) */}
      {approved.length > 0 && (
        <section className="mt-6 px-4">
          <button
            type="button"
            onClick={() => setSheetOpen(true)}
            className="focus-ring block w-full rounded-2xl text-left"
          >
            <Card className="flex items-center gap-3 p-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Store className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="font-semibold">Your restaurants &amp; hours</p>
                <p className="truncate text-sm text-muted-foreground">
                  {isOnline
                    ? `Online for ${scopeLabel || 'your restaurants'} · tap to change`
                    : 'Choose restaurants & set your hours'}
                </p>
              </div>
              <ChevronRight className="h-5 w-5 shrink-0 text-muted-foreground" />
            </Card>
          </button>
        </section>
      )}

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
                  ? `${active.itemsSummary} · ${kmToMi(active.distanceKm).toFixed(1)} mi · ${formatCurrency(active.driverEarnings)}`
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
            timeoutSeconds={
              // Server truth (dispatch v2 offer_expires_at); the pg_cron sweep
              // enforces it even if the app is closed. 45s fallback for legacy offers.
              offered.offerExpiresAt
                ? Math.max(5, Math.round((new Date(offered.offerExpiresAt).getTime() - Date.now()) / 1000))
                : 45
            }
            onAccept={() => {
              void (async () => {
                const ok = await accept();
                // Hand the driver straight to the active run instead of stranding
                // them on the home screen to hunt for the Active-tab badge.
                if (ok) router.push('/app/active');
              })();
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

      <AvailabilitySheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        approved={approved.map((a) => ({ branch_id: a.branch_id, name: a.branch?.name ?? 'Restaurant' }))}
        initialScope={scope}
        isOnline={isOnline}
        applying={toggling}
        blocked={inCooldown}
        onApply={applyFromSheet}
      />
    </div>
  );
}

function PowerButton({
  online,
  onClick,
  label,
  disabled,
}: {
  online: boolean;
  onClick: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <motion.button
      whileTap={disabled ? undefined : { scale: 0.94 }}
      onClick={onClick}
      disabled={disabled}
      className="focus-ring relative grid h-36 w-36 place-items-center rounded-full disabled:cursor-not-allowed disabled:opacity-80"
      aria-label={label}
    >
      {online && (
        <span className="absolute inset-1 animate-pulse-ring rounded-full bg-white/25" />
      )}
      <span
        className={cn(
          'relative grid h-28 w-28 place-items-center rounded-full ring-1 transition-all duration-300',
          online
            ? 'bg-white text-primary shadow-[0_0_50px_rgba(255,255,255,0.45)] ring-white/70'
            : 'bg-white/95 text-stone-600 shadow-lg ring-white/40',
        )}
      >
        <Power className="h-11 w-11" strokeWidth={2.5} />
      </span>
      <span className="absolute -bottom-8 whitespace-nowrap font-display text-sm font-bold text-white drop-shadow">
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

function formatCountdown(totalSec: number): string {
  const s = Math.max(0, totalSec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, '0')}`;
}

