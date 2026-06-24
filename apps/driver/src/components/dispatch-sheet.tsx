'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { Bike, Check, MapPin, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, kmToMi } from '@favornoms/shared';
import type { ActiveDeliveryUI } from './delivery-provider';

interface DispatchSheetProps {
  offer: ActiveDeliveryUI;
  timeoutSeconds: number;
  onAccept: () => void;
  onReject: () => void;
  onTimeout: () => void;
}

export function DispatchSheet({
  offer,
  timeoutSeconds,
  onAccept,
  onReject,
  onTimeout,
}: DispatchSheetProps) {
  const t = useTranslations('dispatch');
  const [remaining, setRemaining] = React.useState(timeoutSeconds);
  const [busy, setBusy] = React.useState(false);
  // Mirror busy in a ref so the countdown closure can see an in-flight accept/reject and
  // suppress the timeout — otherwise a tap at ~0s races a reject('timeout') on the same offer.
  const busyRef = React.useRef(false);
  const onTimeoutRef = React.useRef(onTimeout);
  onTimeoutRef.current = onTimeout;

  React.useEffect(() => {
    setRemaining(timeoutSeconds);
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          if (!busyRef.current) onTimeoutRef.current();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [offer.id, timeoutSeconds]);

  const pct = (remaining / timeoutSeconds) * 100;
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
                <p className="text-xs uppercase tracking-wider text-white/80">{t('newOrder')}</p>
                <p className="font-display text-xl font-bold leading-tight">
                  {formatCurrency(offer.driverEarnings)} · {kmToMi(offer.distanceKm).toFixed(1)} mi
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
            title={t('to')}
            primary={offer.customerName}
            secondary={offer.customerAddress}
          />

          <div className="grid grid-cols-3 divide-x divide-border rounded-2xl bg-muted/40 p-3">
            <Metric label="Distance" value={`${kmToMi(offer.distanceKm).toFixed(1)} mi`} />
            <Metric label="ETA" value={`${offer.estimatedDurationMin} min`} />
            <Metric label="Earning" value={formatCurrency(offer.driverEarnings)} highlight />
          </div>

          <div className="rounded-2xl bg-muted/40 p-4 text-sm">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {offer.orderNumber}
            </p>
            <p className="mt-1 font-medium">{offer.itemsSummary}</p>
            {offer.customerNotes && (
              <p className="mt-2 rounded-lg bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">Note: </span>
                {offer.customerNotes}
              </p>
            )}
            {offer.dropoffNotes && (
              <p className="mt-2 rounded-lg bg-card/60 px-3 py-2 text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">📍 Delivery note: </span>
                {offer.dropoffNotes}
              </p>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 border-t border-border/60 bg-card px-5 pb-safe pt-4">
          <motion.button
            whileTap={{ scale: 0.96 }}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              busyRef.current = true;
              setBusy(true);
              onReject();
            }}
            className="focus-ring inline-flex h-16 items-center justify-center gap-2 rounded-2xl border-2 border-border bg-card text-base font-semibold text-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            <X className="h-5 w-5" />
            {t('reject')}
          </motion.button>
          <motion.button
            whileTap={{ scale: 0.96 }}
            disabled={busy}
            onClick={() => {
              if (busy) return;
              busyRef.current = true;
              setBusy(true);
              if ('vibrate' in navigator) navigator.vibrate([60, 30, 60]);
              onAccept();
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
