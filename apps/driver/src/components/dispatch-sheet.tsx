'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { Bike, Check, MapPin, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import { offerKey, secondsLeft, type DispatchNotice } from '@/lib/alerts';
import { useDelivery, type ActiveDeliveryUI, type DispatchAnswer } from './delivery-provider';

/** How long "this offer is no longer yours" stays up once the sheet has gone. */
const GONE_TOAST_MS = 6_000;

/**
 * The offer overlay for every screen in the app.
 *
 * Mounted in the /app layout, not on Home. An offer arrives over realtime wherever the
 * rider happens to be standing, and while the sheet lived on the home screen alone, one
 * that landed while they were on Active, Map, History, Earnings or Profile put a '!'
 * badge on the Active tab that led to "no active delivery" — an unaccepted offer is not
 * yet active, so the only screen with an Accept button was one the rider had no reason to
 * open. The offer then lapsed at offer_expires_at and reject_dispatch('timeout') stamped
 * a penalty for declining something they were never shown. With the notification worker
 * unconfigured there is no push to pull them to Home either, so this has to find them.
 */
export function DispatchOfferOverlay() {
  const router = useRouter();
  const t = useTranslations('dispatch');
  const { offered, offerDeadlineMs, accept, reject } = useDelivery();

  // The arrival alert (an urgent chime every few seconds, and vibration) lives in DriverAlerts
  // now, keyed on the same offer. It used to be one buzz from here, which an iPhone never felt
  // and Chrome blocked until the rider had touched the screen.

  // What the server said when it did not take the rider's answer, for the offer it was about.
  const [notice, setNotice] = React.useState<{ offerId: string; kind: DispatchNotice } | null>(null);

  const answer = async (offerId: string, run: () => Promise<DispatchAnswer>): Promise<boolean> => {
    const result = await run();
    if (result.ok) {
      setNotice((current) => (current?.offerId === offerId ? null : current));
      return true;
    }
    setNotice({ offerId, kind: result.notice });
    return false;
  };

  // A notice belongs to its offer. Once another offer is on screen it is stale, and must not
  // come back as the "no longer yours" toast when that one leaves.
  const offeredId = offered?.id ?? null;
  React.useEffect(() => {
    if (offeredId) setNotice((current) => (current && current.offerId !== offeredId ? null : current));
  }, [offeredId]);

  // A refused answer keeps the sheet up while the server is asked what the offer is now. When the
  // answer is that it moved on, the sheet goes, and this says why rather than letting the offer
  // simply vanish under the rider's thumb.
  const goneToast =
    !offered && notice && (notice.kind === 'offerGone' || notice.kind === 'offerExpired') ? notice.kind : null;
  React.useEffect(() => {
    if (!goneToast) return;
    const id = window.setTimeout(() => setNotice(null), GONE_TOAST_MS);
    return () => window.clearTimeout(id);
  }, [goneToast, notice]);

  return (
    <>
      <AnimatePresence>
        {offered && offerDeadlineMs != null && (
          // One sheet per offer. Unkeyed, an offer that arrived while the last sheet was still
          // sliding away took that sheet over, busy from the answer just given: both buttons
          // disabled and its timeout suppressed, so the rider could not take it and the sweep
          // struck them for letting it lapse.
          <DispatchSheet
            key={offerKey(offered)}
            offer={offered}
            deadlineMs={offerDeadlineMs}
            notice={notice?.offerId === offered.id ? notice.kind : null}
            onAccept={async () => {
              const ok = await answer(offered.id, () => accept(offered.id));
              // Hand the rider straight to the active run instead of leaving them on
              // whatever screen the offer interrupted.
              if (ok) router.push('/app/active');
              return ok;
            }}
            onReject={() => answer(offered.id, () => reject(offered.id, 'declined'))}
            onTimeout={() => answer(offered.id, () => reject(offered.id, 'timeout'))}
          />
        )}
      </AnimatePresence>
      {goneToast && (
        <p
          role="status"
          className="fixed inset-x-3 bottom-24 z-[125] rounded-2xl bg-foreground/90 px-4 py-3 text-center text-sm font-medium text-background shadow-warm"
        >
          {t(`notice.${goneToast}`)}
        </p>
      )}
    </>
  );
}

interface DispatchSheetProps {
  offer: ActiveDeliveryUI;
  /** When the offer is over on this phone (DeliveryProvider offerDeadlineMs). */
  deadlineMs: number;
  /** Why the last answer did not go through, if it did not. */
  notice: DispatchNotice | null;
  /** Each resolves true when the server took the answer; false leaves the sheet up to retry. */
  onAccept: () => Promise<boolean>;
  onReject: () => Promise<boolean>;
  onTimeout: () => Promise<boolean>;
}

export function DispatchSheet({
  offer,
  deadlineMs,
  notice,
  onAccept,
  onReject,
  onTimeout,
}: DispatchSheetProps) {
  const t = useTranslations('dispatch');
  const [now, setNow] = React.useState(() => Date.now());
  // The full length of the countdown as this sheet first showed it, for the ring around it. Per
  // offer: a refreshed row for the same offer must not restart the ring.
  const totalRef = React.useRef<{ id: string; seconds: number } | null>(null);
  if (totalRef.current?.id !== offer.id) {
    totalRef.current = { id: offer.id, seconds: Math.max(1, secondsLeft(deadlineMs, Date.now())) };
  }
  const total = totalRef.current.seconds;
  const remaining = secondsLeft(deadlineMs, now);
  const [busy, setBusy] = React.useState(false);
  // Mirror busy in a ref so the countdown closure can see an in-flight accept/reject and
  // suppress the timeout — otherwise a tap at ~0s races a reject('timeout') on the same offer.
  const busyRef = React.useRef(false);
  const onTimeoutRef = React.useRef(onTimeout);
  onTimeoutRef.current = onTimeout;
  const mountedRef = React.useRef(true);
  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // False while the sheet slides away after its offer ended (AnimatePresence keeps it mounted
  // for that). A leaving sheet answers nothing: its countdown stops, and its buttons go dead, so
  // neither a late tap nor a deadline reached mid-exit can reach whatever offer comes next.
  const isPresent = useIsPresent();
  const presentRef = React.useRef(isPresent);
  presentRef.current = isPresent;

  // The countdown reads the clock against the deadline on every tick instead of counting ticks:
  // a phone that dimmed slows or stops its timers, and a count of ticks then shows seconds the
  // offer no longer has.
  React.useEffect(() => {
    if (!isPresent) return;
    let fired = false;
    const tick = () => {
      const at = Date.now();
      setNow(at);
      if (at < deadlineMs || fired) return;
      fired = true;
      window.clearInterval(id);
      if (!busyRef.current) void onTimeoutRef.current();
    };
    const id = window.setInterval(tick, 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    tick();
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [offer.id, deadlineMs, isPresent]);

  // A tap that the server did not take hands the buttons back, so the rider can try again.
  const answer = (run: () => Promise<boolean>) => {
    if (busyRef.current || !presentRef.current) return;
    busyRef.current = true;
    setBusy(true);
    void run().then((ok) => {
      if (ok || !mountedRef.current) return;
      busyRef.current = false;
      setBusy(false);
    });
  };

  const pct = (remaining / total) * 100;
  const circumference = 2 * Math.PI * 36;
  const offset = circumference * (1 - pct / 100);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[120] bg-black/70 backdrop-blur-md"
    >
      <motion.div
        initial={{ y: '100%' }}
        animate={{ y: 0 }}
        exit={{ y: '100%' }}
        transition={{ type: 'spring', stiffness: 360, damping: 32 }}
        className="absolute inset-x-0 bottom-0 flex max-h-[94dvh] flex-col rounded-t-3xl bg-card text-card-foreground shadow-2xl"
      >
        <div className="relative overflow-hidden rounded-t-3xl bg-gradient-warm p-5 text-white">
          <div className="absolute inset-0 bg-noise opacity-20" />
          <div className="relative flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="grid h-12 w-12 place-items-center rounded-2xl bg-white/20 backdrop-blur">
                <Bike className="h-7 w-7" />
              </div>
              <div>
                <p className="text-xs uppercase tracking-wider text-white/80">
                  {offer.batchMate ? t('stacked') : t('newOrder')}
                </p>
                <p className="font-display text-xl font-bold leading-tight">
                  {t('headline', {
                    amount: formatCurrency(offer.driverEarnings + (offer.batchMate?.driverEarnings ?? 0)),
                    miles: kmToMi(offer.distanceKm).toFixed(1),
                  })}
                </p>
              </div>
            </div>

            <div className="relative grid h-20 w-20 place-items-center">
              <svg viewBox="0 0 80 80" className="absolute inset-0 -rotate-90">
                <circle cx="40" cy="40" r="36" stroke="rgba(255,255,255,0.2)" strokeWidth="6" fill="none" />
                <motion.circle
                  cx="40"
                  cy="40"
                  r="36"
                  stroke="white"
                  strokeWidth="6"
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={offset}
                  animate={{ strokeDashoffset: offset }}
                  transition={{ duration: 0.9, ease: 'linear' }}
                />
              </svg>
              <span className="font-display text-2xl font-bold tabular-nums">{remaining}</span>
            </div>
          </div>
        </div>

        <div className="flex-1 space-y-4 overflow-y-auto px-5 py-5">
          <Step
            color="primary"
            icon={<MapPin className="h-5 w-5" />}
            title={t('from')}
            primary={offer.branchName}
            secondary={offer.branchAddress}
          />
          <div className="ml-6 h-6 w-0.5 rounded-full bg-border" />
          <Step
            color="accent"
            icon={<MapPin className="h-5 w-5" />}
            title={offer.batchMate ? t('toStop', { stop: '1' }) : t('to')}
            primary={offer.customerName}
            secondary={offer.customerAddress}
          />
          {offer.batchMate && (
            <>
              <div className="ml-6 h-6 w-0.5 rounded-full bg-border" />
              <Step
                color="accent"
                icon={<MapPin className="h-5 w-5" />}
                title={t('toStop', { stop: '2' })}
                primary={offer.batchMate.customerName}
                secondary={offer.batchMate.customerAddress}
              />
            </>
          )}

          <div className="grid grid-cols-3 divide-x divide-border rounded-2xl bg-muted/40 p-3">
            <Metric
              label={t('distance')}
              value={t('distanceValue', { miles: kmToMi(offer.distanceKm).toFixed(1) })}
            />
            <Metric
              label={t('eta')}
              value={t('etaValue', { minutes: String(offer.estimatedDurationMin) })}
            />
            <Metric
              label={offer.batchMate ? t('baseBatch') : t('base')}
              value={formatCurrency(offer.driverEarnings + (offer.batchMate?.driverEarnings ?? 0))}
              highlight
            />
          </div>

          {(() => {
            const tipTotal = (offer.netTip ?? 0) + (offer.batchMate?.netTip ?? 0);
            const fullTotal =
              offer.tipFullVisible != null || offer.batchMate?.tipFullVisible != null
                ? (offer.tipFullVisible ?? 0) + (offer.batchMate?.tipFullVisible ?? 0)
                : null;
            if (tipTotal <= 0) return null;
            return (
              <div className="flex items-center justify-between rounded-2xl bg-primary/10 px-4 py-3">
                <span className="text-sm font-medium text-foreground">
                  {t('tip')}{' '}
                  <span className="text-muted-foreground">
                    {fullTotal != null
                      ? t('tipYourShare', { amount: formatCurrency(fullTotal) })
                      : t('tipAllYours')}
                  </span>
                </span>
                <span className="font-display text-lg font-bold text-primary">
                  +{formatCurrency(tipTotal)}
                </span>
              </div>
            );
          })()}

          <div className="rounded-2xl bg-muted/40 p-4 text-sm">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {offer.orderNumber}
            </p>
            <p className="mt-1 font-medium">{offer.itemsSummary}</p>
            {offer.customerNotes && (
              <p className="mt-2 rounded-lg bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{t('note')} </span>
                {offer.customerNotes}
              </p>
            )}
            {offer.dropoffNotes && (
              <p className="mt-2 rounded-lg bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">📍 {t('deliveryNote')} </span>
                {offer.dropoffNotes}
              </p>
            )}
          </div>

          {offer.batchMate && (
            <div className="rounded-2xl bg-muted/40 p-4 text-sm">
              <p className="text-xs uppercase tracking-wider text-muted-foreground">
                {t('orderStop', { orderNumber: offer.batchMate.orderNumber, stop: '2' })}
              </p>
              <p className="mt-1 font-medium">{offer.batchMate.itemsSummary}</p>
            </div>
          )}
        </div>

        {notice && (
          <p
            role="alert"
            className="mx-5 mb-1 rounded-xl bg-danger/10 px-3 py-2 text-sm font-medium text-danger"
          >
            {t(`notice.${notice}`)}
          </p>
        )}
        <div className="grid grid-cols-2 gap-3 border-t border-border/60 bg-card px-5 pb-safe pt-4">
          <motion.button
            whileTap={{ scale: 0.96 }}
            disabled={busy || !isPresent}
            onClick={() => answer(onReject)}
            className="focus-ring inline-flex h-16 items-center justify-center gap-2 rounded-2xl border-2 border-border bg-card text-base font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <X className="h-5 w-5" />
            {t('reject')}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.96 }}
            disabled={busy || !isPresent}
            onClick={() => {
              if (busyRef.current || !presentRef.current) return;
              if ('vibrate' in navigator) navigator.vibrate([60, 30, 60]);
              answer(onAccept);
            }}
            className="focus-ring relative inline-flex h-16 items-center justify-center gap-2 overflow-hidden rounded-2xl bg-gradient-warm text-base font-semibold text-white shadow-warm disabled:opacity-60"
          >
            <span className="absolute inset-0 bg-gradient-warm bg-[length:200%_200%] animate-gradient" />
            <span className="relative inline-flex items-center gap-2">
              <Check className="h-5 w-5" />
              {t('accept')}
            </span>
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Step({
  color,
  icon,
  title,
  primary,
  secondary,
}: {
  color: 'primary' | 'accent';
  icon: React.ReactNode;
  title: string;
  primary: string;
  secondary: string;
}) {
  return (
    <div className="flex items-start gap-3">
      <div
        className={`grid h-12 w-12 shrink-0 place-items-center rounded-2xl shadow-soft ${
          color === 'primary' ? 'bg-primary text-primary-foreground' : 'bg-accent text-accent-foreground'
        }`}
      >
        {icon}
      </div>
      <div>
        <p className="text-xs uppercase tracking-wider text-muted-foreground">{title}</p>
        <p className="font-display text-base font-semibold leading-tight">{primary}</p>
        <p className="text-sm text-muted-foreground">{secondary}</p>
      </div>
    </div>
  );
}

function Metric({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="px-2 text-center">
      <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 font-display text-base font-bold ${highlight ? 'text-primary' : ''}`}>{value}</p>
    </div>
  );
}
