import type { LiftCooldownOutcome } from '@favornoms/database/queries';

// A rider's strike cooldown (drivers.cooldown_until), as the screens that show it need it. The
// cooldown is set by the database (two missed or declined offers in 24 hours) and only ever
// ends on its own or through lift_driver_cooldown, so all a screen decides is whether it is
// still running, how to write when it ends, and what to say after a lift.

/** The end of a cooldown that is still running, or null when there is none (or it is over). */
export function activeCooldownUntil(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const until = Date.parse(iso);
  return Number.isFinite(until) && until > nowMs ? iso : null;
}

/**
 * When a running cooldown ends, written the way the person reading it checks a clock: just the
 * time when it ends today, the date as well when it does not (a cooldown set late at night that
 * runs past midnight). Formatted on the viewer's device, in their time zone, because "until
 * 16:32" means nothing if it was written in the server's UTC. Null when there is nothing to say.
 */
export function cooldownEndLabel(
  iso: string | null | undefined,
  nowMs: number,
  intlLocale: string,
  timeZone?: string,
): string | null {
  const active = activeCooldownUntil(iso, nowMs);
  if (!active) return null;
  const end = new Date(active);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const sameDay = day.format(end) === day.format(new Date(nowMs));
  return new Intl.DateTimeFormat(intlLocale, {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    ...(sameDay ? {} : { month: 'short', day: 'numeric' }),
  }).format(end);
}

/** What the roster says after a press of "Lift cooldown", as a key under drivers.cooldown. */
export interface LiftMessage {
  key: 'lifted' | 'alreadyOver' | 'forbidden' | 'sharedForbidden' | 'failed';
  /** `done`: the rider can go online (lifted now, or it had already ended); `error`: nothing changed. */
  tone: 'done' | 'error';
}

/**
 * The sentence for a lift's outcome. "Already over" is not a failure — the rider can go online,
 * which is what the merchant wanted — but it is not "lifted" either, and saying so explains why
 * the badge was gone before they pressed anything.
 */
export function liftMessage(outcome: LiftCooldownOutcome): LiftMessage {
  if (outcome.ok) return { key: 'lifted', tone: 'done' };
  if (outcome.reason === 'alreadyOver') return { key: 'alreadyOver', tone: 'done' };
  return { key: outcome.reason, tone: 'error' };
}
