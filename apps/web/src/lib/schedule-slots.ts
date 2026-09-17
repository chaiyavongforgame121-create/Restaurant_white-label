// Turns a branch's opening hours into the concrete list of times a diner may pick.
//
// The checkout scheduler was <input type="datetime-local" min={now+15m} max={now+14d}> — a
// free-form clock that knew nothing about the restaurant. A diner could choose 3am on a day
// the branch is shut, complete the whole form, press Place order, and only then be told
// 'branch_closed_at_scheduled_time'. Correct, and useless at that point.
//
// Everything here is computed in the BRANCH's timezone. That is the whole difficulty: a
// diner in California ordering from a Texas branch must be offered the windows the kitchen
// keeps, not the ones their phone thinks are happening. Slot labels are branch-local wall
// time; the value handed to place-order is a UTC instant, which is what the server compares
// against is_branch_open().
//
// Opening hours are only half the question. A shop can be open all day and still take
// pre-orders in a narrower band — the owner's case is bookings from 17:00 Monday to
// Saturday but 10:00-14:00 on Sunday — which branch_hours cannot express. Those windows
// live in branch_schedule_hours and arrive here as `scheduleWindows`; they NARROW opening
// hours and never extend them, because is_branch_open() still has the final say at submit.

import { intlLocaleFor, isUiLocale, wallTimeToUtc, type UiLocale } from '@favornoms/shared';
import {
  bookableRangesForDay,
  intersectRanges,
  openRangesForDay,
  type MinuteRange,
  type WeekdayWindow,
} from '@favornoms/shared';

/** The branch_hours row shape, under the name the storefront has always used for it. The
 *  model itself now lives in @favornoms/shared, where the merchant editor reads it too —
 *  two copies of these three overnight clauses is how the picker and the server drift. */
export type OpeningWindow = WeekdayWindow;

export interface ClosurePeriod {
  /** UTC ISO instants, straight from branch_closures. */
  starts_at: string;
  ends_at: string;
}

export interface ScheduleSlot {
  /** UTC ISO instant — what gets sent as scheduled_for. */
  iso: string;
  /** Branch-local wall time in the interface language, e.g. "5:30 PM" / "17:30 น.". */
  label: string;
}

export interface ScheduleDay {
  /** YYYY-MM-DD in the branch's zone; the select's value. */
  date: string;
  label: string;
  slots: ScheduleSlot[];
}

export interface BuildScheduleInput {
  timezone: string;
  /** EMPTY means no hours configured, which is_branch_open() treats as always open —
   *  not as closed all week. Flattening those two would silently kill scheduling for
   *  every branch that never filled in Opening hours. */
  openingHours: OpeningWindow[];
  /** Per-weekday windows a diner may BOOK inside, narrowing openingHours.
   *  null/undefined = the merchant never armed the feature, so opening hours alone decide.
   *  An EMPTY ARRAY is a different statement: armed with no windows, so nothing is bookable
   *  all week. Flattening those two would apply branch_hours' "no rows = always open" rule
   *  to a table whose whole purpose is the opposite. */
  scheduleWindows?: OpeningWindow[] | null;
  /** Delivery hours (branch_delivery_hours), narrowing again for a delivery booking. The same
   *  null/empty distinction as scheduleWindows: null = the merchant never restricted delivery
   *  hours, an EMPTY ARRAY = restricted with no windows, so nothing is deliverable. The rows
   *  follow is_delivery_available()'s overnight rules — the same three clauses as
   *  is_schedule_window_open() — so the same range builder reads both. */
  deliveryWindows?: OpeningWindow[] | null;
  /** Slots falling inside one of these are dropped, matching is_branch_open()'s
   *  `p_at between starts_at and ends_at` — inclusive at both ends. */
  closures?: ClosurePeriod[];
  minLeadMinutes: number;
  maxDays: number;
  slotMinutes: number;
  /** Injected so this is testable and so a single render uses one consistent clock. */
  now?: Date;
  /** Interface language of the day and time labels. English (en-US) when omitted, and for
   *  anything that is not a UiLocale — a caller that only counts the days need not care. Only
   *  the labels change: the dates, the instants and which slots exist are the same in every
   *  language. */
  locale?: UiLocale;
  /** What the first two days are called, already translated by the caller. 'Today' and
   *  'Tomorrow' when omitted. */
  dayLabels?: { today: string; tomorrow: string };
}

const ENGLISH_DAY_LABELS = { today: 'Today', tomorrow: 'Tomorrow' } as const;

// How each interface language reads a clock time, matching describeRanges() in
// @favornoms/shared so a diner's slot list and a merchant's hours read alike: English and Latin
// American Spanish on the 12-hour clock, Vietnamese and Thai on the 24-hour one, Thai with น.
const TIME_OPTIONS: Record<UiLocale, Intl.DateTimeFormatOptions> = {
  en: { hour: 'numeric', minute: '2-digit' },
  es: { hour: 'numeric', minute: '2-digit', hour12: true },
  vi: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
  th: { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' },
};
const TIME_SUFFIX: Record<UiLocale, string> = { en: '', es: '', vi: '', th: ' น.' };

/** Newer ICU puts a narrow no-break space before AM/PM (and plain no-break spaces inside
 *  Spanish "p. m."); normalised so every label wraps and compares like the rest of the page. */
function plainSpaces(text: string): string {
  return text.replace(/[  ]/g, ' ');
}

/** The branch-local calendar date and weekday at a given instant. */
function branchDateParts(date: Date, tz: string): { y: number; m: number; d: number; dow: number } {
  // Always en-US: these parts are parsed back into numbers and weekday keys, never shown.
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(date)) parts[p.type] = p.value;
  const DOW: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    y: Number(parts.year),
    m: Number(parts.month),
    d: Number(parts.day),
    dow: DOW[parts.weekday ?? ''] ?? 0,
  };
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function buildScheduleDays(input: BuildScheduleInput): ScheduleDay[] {
  const { timezone, openingHours, scheduleWindows, deliveryWindows, minLeadMinutes, maxDays, slotMinutes } =
    input;
  const now = input.now ?? new Date();
  const locale: UiLocale = isUiLocale(input.locale) ? input.locale : 'en';
  const dayLabels = input.dayLabels ?? ENGLISH_DAY_LABELS;
  const earliest = now.getTime() + Math.max(0, minLeadMinutes) * 60_000;
  // No upper instant cutoff on purpose. The horizon is a number of branch-local DAYS, and
  // the day loop below already stops at the last of them. A `now + maxDays * 24h` cutoff
  // looks equivalent and is not: with maxDays = 0 it lands exactly on `now`, which threw
  // away every remaining slot today — the opposite of "same-day only".
  const step = Math.max(5, slotMinutes);

  // Parsed once. A closure is an absolute instant range, so it is compared against the
  // slot's UTC instant and needs no timezone arithmetic at all — which is why it is the one
  // gate here that cannot drift from the branch's zone.
  const closureBounds = (input.closures ?? [])
    .map((c) => [Date.parse(c.starts_at), Date.parse(c.ends_at)] as const)
    .filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end));
  const insideClosure = (ms: number) => closureBounds.some(([start, end]) => ms >= start && ms <= end);

  const intlLocale = intlLocaleFor(locale);
  const timeFmt = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    ...TIME_OPTIONS[locale],
  });
  const formatTime = (date: Date) => `${plainSpaces(timeFmt.format(date))}${TIME_SUFFIX[locale]}`;
  const dayFmt = new Intl.DateTimeFormat(intlLocale, {
    timeZone: timezone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });

  const today = branchDateParts(now, timezone);
  const days: ScheduleDay[] = [];

  // maxDays is inclusive of today, so a branch set to 0 still offers the rest of today.
  for (let offset = 0; offset <= Math.max(0, maxDays); offset += 1) {
    // Step through calendar days using midday, which no DST transition can skip past.
    const probe = new Date(
      wallTimeToUtc(today.y, today.m, today.d + offset, 12, 0, timezone),
    );
    const parts = branchDateParts(probe, timezone);
    let ranges: MinuteRange[] = openRangesForDay(openingHours, parts.dow);
    // Both gates, in this order. A bookable window can only NARROW opening hours, never
    // extend them: a merchant who takes bookings 17:00-22:00 on a day the kitchen shuts at
    // 21:00 gets 17:00-21:00, not an hour is_branch_open() would refuse at submit.
    if (scheduleWindows) {
      ranges = intersectRanges(ranges, bookableRangesForDay(scheduleWindows, parts.dow));
    }
    // Delivery hours last. orders_enforce_delivery_hours judges a booked delivery at its
    // scheduled_for, so a slot outside them is one the database refuses at submit.
    if (deliveryWindows) {
      ranges = intersectRanges(ranges, bookableRangesForDay(deliveryWindows, parts.dow));
    }
    if (ranges.length === 0) continue;

    const slots: ScheduleSlot[] = [];
    const seen = new Set<number>();
    for (const [from, to] of ranges) {
      // Start on a slot boundary so the offered times read 5:00, 5:15 … rather than
      // inheriting whatever minute the branch happens to open at.
      const start = Math.ceil(from / step) * step;
      for (let mins = start; mins < to; mins += step) {
        const ms = wallTimeToUtc(parts.y, parts.m, parts.d, Math.floor(mins / 60), mins % 60, timezone);
        if (ms < earliest) continue;
        // is_branch_open() rejects any instant inside a branch_closures row, so offering
        // one sends the diner through the whole form to a 409 on a public holiday.
        if (insideClosure(ms)) continue;
        if (seen.has(ms)) continue; // overlapping windows must not double up
        seen.add(ms);
        slots.push({ iso: new Date(ms).toISOString(), label: formatTime(new Date(ms)) });
      }
    }
    if (slots.length === 0) continue;

    slots.sort((a, b) => a.iso.localeCompare(b.iso));
    days.push({
      date: iso(parts.y, parts.m, parts.d),
      label:
        offset === 0
          ? dayLabels.today
          : offset === 1
            ? dayLabels.tomorrow
            : plainSpaces(dayFmt.format(probe)),
      slots,
    });
  }

  return days;
}
