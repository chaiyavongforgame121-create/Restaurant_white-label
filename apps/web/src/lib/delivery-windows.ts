import type { StorefrontStatus } from '@favornoms/database/queries';

/**
 * Today's delivery windows, for the "delivery is closed right now" explanation.
 *
 * `day_of_week` is 0=Sunday, matching Postgres `extract(dow)` and `Date.getDay()`.
 *
 * The day is taken from the VIEWER's clock, not the branch's. That is a deliberate
 * approximation: `is_delivery_available` — the value that actually decides whether an
 * order can be placed — evaluates in the branch's timezone server-side, and this list
 * is only ever a hint shown alongside it. A diner browsing from another timezone may
 * see the neighbouring day's window named; they are never wrongly allowed to order,
 * because the server answer is what gates the tile.
 */
export function todaysDeliveryWindows(
  status: Pick<StorefrontStatus, 'delivery_windows'>,
): Array<{ opens_at: string; closes_at: string }> {
  const today = new Date().getDay();
  return (status.delivery_windows ?? [])
    .filter((w) => w.day_of_week === today)
    .map((w) => ({ opens_at: w.opens_at, closes_at: w.closes_at }));
}
