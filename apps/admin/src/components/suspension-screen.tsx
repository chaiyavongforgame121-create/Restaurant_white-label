'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Clock, Lock, RefreshCw } from 'lucide-react';
import { Button, Card, cn } from '@favornoms/ui';

/** What is locked. Each has its own whole sentence, because the surface is the subject. */
export type SuspensionSurface = 'counter' | 'screen';

/**
 * Shown on back-office surfaces that create new business (the till) when the subscription has
 * lapsed. Since the lock moved into getBranchAccess, everyone who works at the restaurant is sent
 * to Plan & billing or /suspended before the till renders, so this card is what a platform admin
 * sees: they keep full access, but a sale would only be refused at "Charge" by the BEFORE INSERT
 * billing gate, in front of a customer.
 */
export function SuspensionScreen({
  branchId,
  branchName,
  surface = 'screen',
  canOpenBilling = true,
}: {
  branchId: string;
  branchName?: string;
  /**
   * What is locked, as a code: pass 'counter' for the till. The surface is the subject of the
   * sentence, so a translated noun cannot be slotted in; any other string (including the old
   * English 'The counter', still read as the counter) falls back to "This screen".
   */
  surface?: SuspensionSurface | (string & {});
  /** Offer "Go to billing" only to someone whose back office opens: anyone else is sent on to
   *  /suspended from there, which is no way forward. */
  canOpenBilling?: boolean;
}) {
  const t = useTranslations('shell.suspension');
  const subject: SuspensionSurface = surface === 'counter' || surface === 'The counter' ? 'counter' : 'screen';
  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <Lock className="mx-auto h-12 w-12 text-warning" />
        <h1 className="mt-3 font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {branchName ? t(`locked.${subject}`, { branch: branchName }) : t(`lockedHere.${subject}`)}{' '}
          {t('nothingDeleted')}
        </p>
        <p className="mt-3 text-sm text-muted-foreground">{t('kitchenStillWorks')}</p>
        {canOpenBilling && (
          <Link href={`/b/${branchId}/settings/plan`} className="mt-5 block">
            <Button variant="gradient" fullWidth>
              {t('goToBilling')}
            </Button>
          </Link>
        )}
      </Card>
    </div>
  );
}

/**
 * Asks the server again: router.refresh() renders the layouts as well as the page, so the menu
 * unlocks (or a locked screen moves on) the moment the answer changes. A manual renewal is approved
 * by the FavorNoms team, which nothing on this screen hears about by itself.
 */
export function CheckAgainButton({
  label,
  variant = 'soft',
  size = 'md',
  fullWidth = false,
  className,
}: {
  /** Already translated; defaults to "Check again". */
  label?: string;
  variant?: 'soft' | 'ghost' | 'gradient';
  size?: 'sm' | 'md';
  fullWidth?: boolean;
  className?: string;
}) {
  const t = useTranslations('shell.subscriptionLocked');
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      fullWidth={fullWidth}
      className={className}
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
      leftIcon={<RefreshCw className={cn('h-4 w-4', pending && 'animate-spin')} />}
    >
      {pending ? t('checking') : (label ?? t('checkAgain'))}
    </Button>
  );
}

/** How often a screen that is locked, or open only to finish orders, asks the server again. */
const LOCKED_REFRESH_MS = 60_000;

/**
 * Asks the server again on its own while mounted: every minute, and when the screen comes back
 * into view or back online. A renewal approved by the FavorNoms team, a booking released onto the
 * board, or the last order finished reaches nobody otherwise: a kitchen tablet on the wall is not
 * reloaded by anyone, and has nobody to press Check again. Mount it only while locked; a paying
 * restaurant's screens never run it. A refresh is skipped while a dialog is open, as
 * StaffAccessWatcher skips its reload, so nobody loses what they were typing into one.
 */
function useLockedAutoRefresh(): void {
  const router = useRouter();
  React.useEffect(() => {
    const refresh = () => {
      if (document.visibilityState !== 'visible') return;
      if (document.querySelector('[aria-modal="true"]')) return;
      router.refresh();
    };
    const timer = window.setInterval(refresh, LOCKED_REFRESH_MS);
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
      window.removeEventListener('online', refresh);
    };
  }, [router]);
}

/** useLockedAutoRefresh for a server-rendered lock screen (/suspended, "ask the owner"). */
export function LockedAutoRefresh(): null {
  useLockedAutoRefresh();
  return null;
}

/**
 * The kitchen board and the till's Recent list while the subscription has ended but orders placed
 * before it are still being finished (owner decision 2026-10-27). It asks the server again by
 * itself, so a renewal takes the banner away and the last order finished locks the screen like
 * the rest, without anyone reloading the tablet.
 */
export function SubscriptionEndedBanner() {
  const t = useTranslations('shell.subscriptionLocked');
  useLockedAutoRefresh();
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-warning/30 bg-warning/15 px-4 py-2.5 text-sm text-warning"
    >
      <Clock className="h-4 w-4 shrink-0" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('finishOrdersTitle')}</span>{' '}
        <span className="text-warning/90">{t('finishOrdersBody')}</span>
      </p>
      <CheckAgainButton variant="ghost" size="sm" className="shrink-0" />
    </div>
  );
}

/**
 * The screens still open on a locked branch while orders placed before the end are being finished
 * (the kitchen board and the till's Recent list), for whoever may open them. The lock pages are
 * where the till, the dashboard and sign-in send everyone, and without these links the exception
 * was reachable only by typing its address.
 */
export function StillOpenLinks({
  branchId,
  kitchen,
  recent,
  className,
}: {
  branchId: string;
  /** kitchen.access: the board itself. */
  kitchen: boolean;
  /** counter.access: the till's Recent list. */
  recent: boolean;
  className?: string;
}) {
  const t = useTranslations('shell');
  const tCounter = useTranslations('counter.recent');
  if (!kitchen && !recent) return null;
  return (
    <div
      className={cn(
        'rounded-xl border border-warning/30 bg-warning/10 p-3 text-left text-sm',
        className,
      )}
    >
      <p className="text-muted-foreground">{t('subscriptionLocked.stillOpen')}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {kitchen && (
          <Link
            href={`/kitchen/${branchId}`}
            className="focus-ring inline-flex items-center rounded-lg bg-card px-3 py-1.5 font-semibold text-foreground shadow-soft hover:bg-muted"
          >
            {t('nav.kitchenDisplay')}
          </Link>
        )}
        {recent && (
          <Link
            href={`/counter/${branchId}/recent`}
            className="focus-ring inline-flex items-center rounded-lg bg-card px-3 py-1.5 font-semibold text-foreground shadow-soft hover:bg-muted"
          >
            {tCounter('title')}
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * The subscription could not be read (D8). Nothing is locked on a failed read: a database blip
 * must not hide a paying merchant's whole back office. What depends on the plan stays hidden (it
 * fails closed), and this says why and offers to ask again.
 */
export function SubscriptionUnknownBanner({ className }: { className?: string }) {
  const t = useTranslations('shell.subscriptionUnknown');
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 bg-muted/60 px-4 py-2.5 text-sm',
        className,
      )}
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-warning" aria-hidden />
      <p className="min-w-0 flex-1">
        <span className="font-semibold">{t('title')}</span>{' '}
        <span className="text-muted-foreground">{t('body')}</span>
      </p>
      <CheckAgainButton label={t('retry')} variant="ghost" size="sm" className="shrink-0" />
    </div>
  );
}
