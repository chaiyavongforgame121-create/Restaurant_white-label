'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { TimerReset } from 'lucide-react';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Button } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { liftDriverCooldown } from '@favornoms/database/queries';
import { activeCooldownUntil, cooldownEndLabel, liftMessage, type LiftMessage } from '../_lib/cooldown';

// A rider on a cooldown (two missed or declined offers in 24 hours: an hour; a job they accepted
// and then cancelled: ten minutes) gets no offers and cannot go online, at any branch.
// drivers.cooldown_until does not record which, so the copy names neither cause on its own.
// Nothing could end it early: on 2026-10-05 two riders were put on it by the kitchen's own
// retries (each retry re-offered the order to the rider who had just declined it) and the owner
// had to ask for it to be cleared by hand. This
// is the button for that (D8). The cooldown is the rider's, not the branch's, so the database
// lets a platform admin lift it, or a manager with drivers.manage at every branch the rider
// works for; anyone else is told why, the way the KYC review does.

/** The clock the cooldown line and button read. Null until mounted, so the server render (in the
 *  server's time zone) and the first client render agree; then every 30 s, so a cooldown that
 *  ends while the roster is open stops being offered for lifting. */
function useClock(): number | null {
  const [now, setNow] = React.useState<number | null>(null);
  React.useEffect(() => {
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

function useIntlLocale(): string {
  const raw = useLocale();
  return intlLocaleFor(isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE);
}

/** "On a cooldown until 4:32 PM — no new offers until then", on this device's clock. */
export function CooldownNotice({ until }: { until: string }) {
  const t = useTranslations('drivers');
  const intlLocale = useIntlLocale();
  const now = useClock();
  if (now != null && !activeCooldownUntil(until, now)) return null;
  const time = now == null ? null : cooldownEndLabel(until, now, intlLocale);
  return (
    <p className="mt-1.5 text-xs font-semibold text-warning">
      {time ? t('card.coolingDown', { time }) : t('card.coolingDownNoTime')}
    </p>
  );
}

export function LiftCooldownButton({
  driverId,
  branchId,
  driverName,
  until,
}: {
  driverId: string;
  /** The branch whose roster this is: lift_driver_cooldown checks drivers.manage here (and at
   *  every other branch the rider works for). */
  branchId: string;
  driverName: string;
  /** The running cooldown's end, or null. Rendered either way, so the outcome of a lift is still
   *  on screen after the refresh that clears the cooldown from the page. */
  until: string | null;
}) {
  const t = useTranslations('drivers');
  const router = useRouter();
  const now = useClock();
  const [confirming, setConfirming] = React.useState(false);
  const [note, setNote] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState<LiftMessage | null>(null);

  const running = until != null && (now == null || activeCooldownUntil(until, now) != null);

  const lift = async () => {
    setBusy(true);
    setMessage(null);
    const outcome = await liftDriverCooldown(getBrowserClient(), driverId, branchId, note);
    setBusy(false);
    const msg = liftMessage(outcome);
    // The database's own words go to the log; the merchant gets a sentence.
    if (!outcome.ok && outcome.reason === 'failed') console.error('lift_driver_cooldown failed:', outcome.message);
    setMessage(msg);
    if (msg.tone === 'done') {
      setConfirming(false);
      setNote('');
      router.refresh();
    }
  };

  if (!running && !message) return null;

  return (
    <div className="flex flex-col items-end gap-1.5">
      {running && !confirming && (
        <Button
          size="sm"
          variant="outline"
          leftIcon={<TimerReset className="h-4 w-4" />}
          onClick={() => {
            setMessage(null);
            setConfirming(true);
          }}
        >
          {t('cooldown.lift')}
        </Button>
      )}
      {running && confirming && (
        <div className="w-72 rounded-xl border border-border bg-muted/30 p-2.5 text-left">
          <p className="text-sm font-semibold">{t('cooldown.confirmTitle', { name: driverName })}</p>
          <p className="mt-1 text-xs text-muted-foreground">{t('cooldown.confirmBody', { name: driverName })}</p>
          <label htmlFor={`cooldown-note-${driverId}`} className="mt-2 block text-xs font-semibold">
            {t('cooldown.noteLabel')}
          </label>
          <textarea
            id={`cooldown-note-${driverId}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            // lift_driver_cooldown keeps the first 300 characters in audit_logs.
            maxLength={300}
            placeholder={t('cooldown.notePlaceholder')}
            className="focus-ring mt-1 w-full resize-none rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
          />
          <div className="mt-2 flex justify-end gap-2">
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setNote('');
              }}
            >
              {t('cooldown.cancel')}
            </Button>
            <Button size="sm" variant="primary" loading={busy} onClick={() => void lift()}>
              {t('cooldown.confirm')}
            </Button>
          </div>
        </div>
      )}
      {message && (
        <p
          role={message.tone === 'error' ? 'alert' : 'status'}
          className={`max-w-72 text-right text-xs ${message.tone === 'error' ? 'text-danger' : 'text-success'}`}
        >
          {t(`cooldown.${message.key}`, { name: driverName })}
        </p>
      )}
    </div>
  );
}
