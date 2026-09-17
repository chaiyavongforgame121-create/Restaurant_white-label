/**
 * Wall-clock times in a BRANCH's timezone, and the UTC instants they stand for.
 *
 * Every date-and-time field in the back office is an <input type="datetime-local">, and that
 * input's value carries no zone at all — "2026-12-25T00:01". Written straight into a
 * timestamptz column, Postgres reads a zone-less value as UTC, so the closure a merchant typed
 * as "Christmas Day, 12:01 AM" was stored as 00:01 UTC: 6:01 PM on Christmas Eve at a Chicago
 * shop. The shop closed six hours early and reopened six hours early, the list showed a time
 * the merchant never typed, and customers could order through the hours the merchant believed
 * were blocked.
 *
 * The conversion lived privately in the storefront's slot builder, where the scheduled-order
 * picker already did this correctly. It is shared now so the admin forms do the same thing.
 */

import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale, type UiLocale } from '../i18n';

/** Offset of `tz` from UTC at `date`, in ms. Positive east of Greenwich. */
export function zoneOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  // Intl renders midnight as hour "24" in some engines; normalise before arithmetic.
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - date.getTime();
}

/**
 * Branch-local wall time -> UTC instant, in ms.
 *
 * Two passes on purpose. The offset depends on the instant, and the instant is what we are
 * solving for, so a single pass is wrong on the two days a year the zone changes: a time just
 * after a DST shift lands an hour out. The second pass re-reads the offset at the corrected
 * instant and converges.
 *
 * On the night clocks go back, a wall time that happens twice (1:30 AM in Chicago) resolves
 * to its first, daylight-time occurrence. On the night they go forward, a wall time that never
 * happens (2:30 AM) resolves to a real instant an hour either side rather than throwing —
 * a closure the merchant typed across that gap should still close the shop.
 */
export function wallTimeToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  tz: string,
): number {
  const naive = Date.UTC(y, m - 1, d, hh, mm);
  const firstPass = naive - zoneOffsetMs(new Date(naive), tz);
  return naive - zoneOffsetMs(new Date(firstPass), tz);
}

/** Whether the runtime recognises `tz`. branches.timezone is free text as far as SQL cares. */
export function isValidTimeZone(tz: string | null | undefined): boolean {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * A datetime-local value, read as wall-clock time in `tz`, as a UTC ISO string for the
 * database. Null for a value that is not a datetime-local string, or a zone the runtime does
 * not know — the caller has to refuse the save rather than guess, because guessing is how
 * the six-hour shift happened in the first place.
 */
export function localInputToUtcIso(value: string, tz: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec((value ?? '').trim());
  if (!match || !isValidTimeZone(tz)) return null;
  const [y, mo, d, hh, mi, ss] = match.slice(1).map((part) => Number(part ?? 0));
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    hh === undefined ||
    mi === undefined ||
    mo < 1 ||
    mo > 12 ||
    d < 1 ||
    d > 31 ||
    hh > 23 ||
    mi > 59
  ) {
    return null;
  }
  const ms = wallTimeToUtc(y, mo, d, hh, mi, tz) + (ss ?? 0) * 1000;
  return new Date(ms).toISOString();
}

/** The inverse: a stored instant as a datetime-local value in `tz`, for prefilling a field. */
export function utcToLocalInput(iso: string, tz: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(tz)) return '';
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(date)) {
    parts[p.type] = p.value;
  }
  const hour = String(Number(parts.hour) % 24).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

/**
 * A stored instant, written the way the shop's own clock would say it.
 *
 * `toLocaleString()` with no zone uses the DEVICE's zone, which is why a closure list viewed
 * from another country showed times the merchant never typed. Newer ICU puts a narrow
 * no-break space before AM/PM; it is normalised to a plain space so the text copies, wraps
 * and compares like the rest of the page.
 *
 * `locale` picks the interface language's date order and clock (English, en-US, when omitted);
 * Thai stays on the Gregorian calendar via intlLocaleFor.
 */
export function formatInZone(
  iso: string,
  tz: string,
  opts: { dateOnly?: boolean } = {},
  locale: UiLocale = DEFAULT_UI_LOCALE,
): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || !isValidTimeZone(tz)) return iso;
  const text = new Intl.DateTimeFormat(intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE), {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    ...(opts.dateOnly ? {} : { hour: 'numeric', minute: '2-digit' }),
  }).format(date);
  return text.replace(/[  ]/g, ' ');
}
