'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { AlertCircle } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { setBranchDelivery } from '@favornoms/database/queries';
import { Card, cn, RiderIcon } from '@favornoms/ui';

/**
 * "Delivery at this branch": the merchant's free per-branch switch (docs/PACKAGING-2026-10-24.md
 * §3). Delivery is part of the plan at every branch and on by default; this is how a branch
 * that does not deliver says so. Before, the only way to stop a branch delivering was the paid
 * add-on on the plan page, or delivery hours switched on with no windows.
 *
 * It saves the moment it is flipped, on its own, through public.set_branch_delivery — not with
 * the page's Save button, because the storefront, the counter and dispatch all follow it at
 * once, and a switch that looks off but is not saved would be a lie the merchant only finds
 * when a delivery order arrives.
 */

/** set_branch_delivery's refusals; raw database text never reaches the merchant. */
function saveErrorKey(message: string): string {
  if (message === 'forbidden' || message.includes('42501')) return 'errors.settingsRequired';
  return 'errors.generic';
}

export function DeliverySwitchCard({
  branchId,
  branchName,
  initialOn,
  restaurantOff,
  canEdit,
}: {
  branchId: string;
  branchName: string;
  /** The switch as the page read it; null when it could not be read (the switch then stays put). */
  initialOn: boolean | null;
  /**
   * Delivery is off for the whole restaurant (lapsed, or switched off by the platform), so the
   * branch does not deliver whatever this switch says. Shown as a note; the switch still saves.
   */
  restaurantOff: boolean;
  /** branch.settings: what set_branch_delivery requires. */
  canEdit: boolean;
}) {
  const t = useTranslations('branch');
  const router = useRouter();
  const [on, setOn] = React.useState(initialOn);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Server-rendered HTML shows the switch before React hydrates, and a press then is either
  // lost or replayed against a state the merchant never saw. It stays disabled until this
  // component is live, so the only presses that save are ones it can answer.
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => setHydrated(true), []);

  // A new server read (router.refresh after a save, or another tab's change) wins over what
  // this card last showed.
  React.useEffect(() => setOn(initialOn), [initialOn]);

  const toggle = async () => {
    if (on === null || saving) return;
    const next = !on;
    setSaving(true);
    setError(null);
    try {
      // The answer is the switch as it now stands, so the card shows what the server holds,
      // not what was asked for.
      const now = await setBranchDelivery(getBrowserClient(), branchId, next);
      setOn(now);
      // The delivery cards below, the sidebar's delivery entries and the dashboard all follow
      // this switch; refresh so they agree with it.
      router.refresh();
    } catch (e) {
      console.error('Switching delivery at this branch failed', e);
      setError(t(saveErrorKey(e instanceof Error ? e.message : String(e))));
    } finally {
      setSaving(false);
    }
  };

  const labelId = `delivery-switch-${branchId}`;
  return (
    <Card id="delivery-switch" className="scroll-mt-6 p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 id={labelId} className="flex items-center gap-2 font-display text-lg font-semibold">
            <RiderIcon className="h-5 w-5 text-primary" /> {t('settings.delivery.title')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {on === null
              ? t('settings.delivery.unreadable')
              : on
                ? t('settings.delivery.onBody', { branch: branchName })
                : t('settings.delivery.offBody', { branch: branchName })}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <span className="text-sm font-semibold" aria-hidden>
            {saving
              ? t('settings.delivery.saving')
              : on === null
                ? '—'
                : on
                  ? t('settings.delivery.on')
                  : t('settings.delivery.off')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={on === true}
            aria-labelledby={labelId}
            disabled={!canEdit || !hydrated || saving || on === null}
            onClick={toggle}
            className={cn(
              'focus-ring relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50',
              on ? 'bg-primary' : 'bg-muted-foreground/30',
            )}
          >
            <span
              aria-hidden
              className={cn(
                'inline-block h-5 w-5 rounded-full bg-white shadow transition-transform',
                on ? 'translate-x-6' : 'translate-x-1',
              )}
            />
          </button>
        </div>
      </div>

      <p className="mt-3 text-xs text-muted-foreground">{t('settings.delivery.included')}</p>

      {restaurantOff && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-foreground">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>{t('settings.delivery.notAvailable', { branch: branchName })}</span>
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}
    </Card>
  );
}
