import {
  DEFAULT_UI_LOCALE,
  intlLocaleFor,
  isUiLocale,
  isValidTimeZone,
} from '@favornoms/shared';

/**
 * What "sold out" and "low" mean in the back office. The same tests as v_low_stock_items
 * (is_86, is_low_stock, is_sold_out), the storefront and place-order, written once so the
 * inventory table, its alert lists and the menu grid cannot drift apart.
 */

/** low_stock_threshold is `integer NOT NULL default 5`; the default is mirrored here. */
export const DEFAULT_LOW_STOCK_THRESHOLD = 5;

/** The largest value a Postgres integer column takes. */
const MAX_INT = 2_147_483_647;

export interface StockFields {
  track_stock: boolean | null;
  stock_quantity: number | null;
  low_stock_threshold: number | null;
  sold_out_until: string | null;
}

export interface StockState {
  tracked: boolean;
  /** The count on the shelf; null when the dish is not counted. */
  count: number | null;
  threshold: number;
  /** A hand-set 86 still in force (ISO time it lifts), else null. An expired one is no 86. */
  soldOutUntil: string | null;
  /** 86'd, or counted with nothing left: nobody can order it. */
  isSoldOut: boolean;
  /** Counted, and at or under the alert threshold (0 included). */
  isLow: boolean;
}

export function stockState(row: StockFields, nowMs: number = Date.now()): StockState {
  const tracked = row.track_stock === true;
  // A tracked dish always has a count (menu_items_tracked_stock_has_count); 0 is the old reading
  // of a missing one, kept only so a row read mid-migration still renders.
  const count = tracked ? (row.stock_quantity ?? 0) : null;
  const threshold = row.low_stock_threshold ?? DEFAULT_LOW_STOCK_THRESHOLD;
  const untilMs = row.sold_out_until ? new Date(row.sold_out_until).getTime() : NaN;
  const soldOutUntil = Number.isFinite(untilMs) && untilMs > nowMs ? row.sold_out_until : null;
  return {
    tracked,
    count,
    threshold,
    soldOutUntil,
    isSoldOut: soldOutUntil !== null || (count !== null && count <= 0),
    isLow: count !== null && count <= threshold,
  };
}

/**
 * When the soonest 86 among these rows lifts, in epoch ms, or null. No database write happens at
 * that moment, so a screen that wants to un-grey the dish has to schedule its own refresh.
 */
export function nextSoldOutExpiry(
  rows: ReadonlyArray<{ sold_out_until: string | null }>,
  nowMs: number = Date.now(),
): number | null {
  let soonest: number | null = null;
  for (const r of rows) {
    if (!r.sold_out_until) continue;
    const ms = new Date(r.sold_out_until).getTime();
    if (Number.isFinite(ms) && ms > nowMs && (soonest === null || ms < soonest)) soonest = ms;
  }
  return soonest;
}

/**
 * A whole number typed by the merchant, or null. restock_log.delta, waste_log.quantity and the
 * stock counts are integers: "2.5" used to reach Postgres and come back as a generic
 * "invalid value", so it is refused here with a sentence that says why.
 */
export function parseWholeNumber(raw: string, min: number): number | null {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  if (!Number.isSafeInteger(n) || n < min || n > MAX_INT) return null;
  return n;
}

export type InventoryErrorKey = 'permissionDenied' | 'network' | 'invalidValue' | 'notFound' | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes and RPC refusals get a sentence. */
export function inventoryErrorKey(err: { code?: string; message?: string } | null | undefined): InventoryErrorKey {
  const code = err?.code ?? '';
  const message = err?.message ?? '';
  if (
    code === '42501' ||
    /row-level security|permission denied|not_authorized|auth_required/i.test(message)
  ) {
    return 'permissionDenied';
  }
  if (/item_not_found|item_not_in_branch/i.test(message)) return 'notFound';
  if (/invalid_count|invalid_until/i.test(message) || /^(22|23)/.test(code)) return 'invalidValue';
  if (/failed to fetch|networkerror|network request failed|load failed|fetch failed/i.test(message)) {
    return 'network';
  }
  return 'generic';
}

/**
 * "Sold out until …" in the branch's own clock: the time alone when it lifts later today, with
 * the weekday otherwise (the kitchen's default 86 lifts at midnight, which is tomorrow).
 */
export function formatSoldOutUntil(
  iso: string,
  tz: string,
  locale: string,
  nowMs: number = Date.now(),
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const zone = isValidTimeZone(tz) ? tz : 'UTC';
  const dayKey = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const sameDay = dayKey.format(date) === dayKey.format(new Date(nowMs));
  const text = new Intl.DateTimeFormat(intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE), {
    timeZone: zone,
    ...(sameDay ? {} : { weekday: 'short' as const }),
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
  // Newer ICU puts a narrow no-break space before AM/PM; keep the text plain like formatInZone.
  return text.replace(/[  ]/g, ' ');
}
