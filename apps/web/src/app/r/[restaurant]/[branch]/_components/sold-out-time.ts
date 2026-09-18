import { intlLocaleFor, type MenuItem, type UiLocale } from '@favornoms/shared';

/** The earliest hand-set 86 among `items`, as epoch ms; null when none is set. The query only
 *  passes a sold_out_until that was still ahead when the page was rendered. */
export function earliestSoldOutUntil(items: readonly Pick<MenuItem, 'soldOutUntil'>[]): number | null {
  let min: number | null = null;
  for (const item of items) {
    if (!item.soldOutUntil) continue;
    const at = new Date(item.soldOutUntil).getTime();
    if (Number.isFinite(at) && (min === null || at < min)) min = at;
  }
  return min;
}

interface ZonedParts {
  y: number;
  m: number;
  d: number;
  hour: number;
  minute: number;
}

function zonedParts(at: Date, timeZone: string): ZonedParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const n = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return { y: n('year'), m: n('month'), d: n('day'), hour: n('hour') % 24, minute: n('minute') };
}

/**
 * A shop's clock the way the menu's happy-hour times write it: English and Spanish 12-hour,
 * Thai and Vietnamese 24-hour (Thai adds น.).
 */
function clock(hour: number, minute: number, locale: UiLocale): string {
  const mm = String(minute).padStart(2, '0');
  if (locale === 'th' || locale === 'vi') {
    const hhmm = `${String(hour).padStart(2, '0')}:${mm}`;
    return locale === 'th' ? `${hhmm} น.` : hhmm;
  }
  const [am, pm] = locale === 'es' ? ['a. m.', 'p. m.'] : ['AM', 'PM'];
  const h12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${h12}:${mm} ${hour >= 12 ? pm : am}`;
}

/**
 * When an 86 lifts, in the branch's time zone: the time alone today, the weekday and time within
 * the week, the date and time beyond it. Null for an unreadable timestamp or zone.
 */
export function formatSoldOutUntil(
  iso: string,
  timeZone: string,
  locale: UiLocale,
  now: Date = new Date(),
): string | null {
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime())) return null;
  try {
    const when = zonedParts(at, timeZone);
    const today = zonedParts(now, timeZone);
    const time = clock(when.hour, when.minute, locale);
    const days = Math.round(
      (Date.UTC(when.y, when.m - 1, when.d) - Date.UTC(today.y, today.m - 1, today.d)) / 86_400_000,
    );
    if (days <= 0) return time;
    const day = new Intl.DateTimeFormat(
      intlLocaleFor(locale),
      days < 7 ? { weekday: 'short', timeZone } : { month: 'short', day: 'numeric', timeZone },
    ).format(at);
    return `${day} ${time}`;
  } catch {
    // RangeError: a time zone this browser does not know.
    return null;
  }
}
