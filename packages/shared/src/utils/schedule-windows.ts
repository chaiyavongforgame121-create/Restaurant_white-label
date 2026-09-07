// The weekly-window model three tables in this schema share. branch_hours,
// branch_delivery_hours and branch_schedule_hours all store (day_of_week, opens_at,
// closes_at), and Postgres judges all three with the same three clauses: a window whose
// close is at or before its open crosses midnight, so it is filed under the day it starts
// and spills its morning tail into the next.
//
// It lives here because two apps need that arithmetic before the database gets a say. The
// storefront builds the diner's slot list from these rows, and the merchant editor has to
// show which times a window will actually produce once opening hours have narrowed it.
// Both must agree with is_branch_open() and is_schedule_window_open() to the minute, or the
// picker offers a slot the server then refuses — the exact failure the slot picker replaced
// a free-form clock to remove.
//
// Nothing here knows about timezones, deliberately. These are minute-of-day ranges against
// a weekday the CALLER already resolved in the BRANCH's zone. Resolving it here from the
// host clock is precisely how a shop in Asia/Bangkok ends up judged on a UTC runner's
// weekday, seven hours out.

export interface WeekdayWindow {
  /** 0 = Sunday, matching Postgres extract(dow). */
  day_of_week: number;
  /** 'HH:MM' branch-local wall time. */
  opens_at: string;
  closes_at: string;
}

/** [start, end) in minutes from branch-local midnight; 1440 is the following midnight. */
export type MinuteRange = [number, number];

const DAY_MINUTES = 24 * 60;

export function minutesFromHHMM(value: string): number {
  const [h, m] = value.split(':');
  const hours = Number(h);
  const mins = Number(m);
  return (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(mins) ? mins : 0);
}

export function minutesToHHMM(minutes: number): string {
  const clamped = Math.max(0, Math.min(DAY_MINUTES, Math.round(minutes)));
  return `${String(Math.floor(clamped / 60)).padStart(2, '0')}:${String(clamped % 60).padStart(2, '0')}`;
}

/** The three clauses both readings below share. */
function rangesForDay(windows: WeekdayWindow[], dow: number): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const w of windows) {
    const opens = minutesFromHHMM(w.opens_at);
    const closes = minutesFromHHMM(w.closes_at);
    if (closes > opens) {
      if (w.day_of_week === dow) out.push([opens, closes]);
    } else {
      // Evening side, on the day the window is filed under.
      if (w.day_of_week === dow) out.push([opens, DAY_MINUTES]);
      // Morning side, spilling into the next day.
      if (w.day_of_week === (dow + 6) % 7 && closes > 0) out.push([0, closes]);
    }
  }
  return out;
}

/** branch_hours semantics: ZERO rows means "no hours configured", which is_branch_open()
 *  reads as always open. Flattening that to "closed" would silently stop orders for every
 *  branch that never filled the grid in. */
export function openRangesForDay(windows: WeekdayWindow[], dow: number): MinuteRange[] {
  if (windows.length === 0) return [[0, DAY_MINUTES]];
  return rangesForDay(windows, dow);
}

/** branch_schedule_hours semantics, the exact opposite. The merchant armed this feature on
 *  purpose, so an empty week means nothing is bookable; is_schedule_window_open() has no
 *  "no rows = always" short-circuit either. Copying the fail-open rule across would invert
 *  the merchant's intent the first time they saved an empty day. */
export function bookableRangesForDay(windows: WeekdayWindow[], dow: number): MinuteRange[] {
  return rangesForDay(windows, dow);
}

/** Minute ranges present in BOTH lists. Both sides are expressed against the same calendar
 *  day — each has already spilled its own overnight tail forward — so a pairwise
 *  intersection is the whole of it. */
export function intersectRanges(a: MinuteRange[], b: MinuteRange[]): MinuteRange[] {
  const out: MinuteRange[] = [];
  for (const [aStart, aEnd] of a) {
    for (const [bStart, bEnd] of b) {
      const start = Math.max(aStart, bStart);
      const end = Math.min(aEnd, bEnd);
      if (end > start) out.push([start, end]);
    }
  }
  return out;
}

/** Overlapping or touching ranges collapsed into one. A merchant may legitimately save
 *  11:00-14:00 and 12:00-15:00 on the same day, and reading "11:00 AM – 2:00 PM, 12:00 PM –
 *  3:00 PM" back to them is a summary of nothing. */
export function mergeRanges(ranges: MinuteRange[]): MinuteRange[] {
  const sorted = [...ranges].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out: MinuteRange[] = [];
  for (const [start, end] of sorted) {
    const last = out[out.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else out.push([start, end]);
  }
  return out;
}

/** What a diner can actually book on `dow`: the bookable windows NARROWED by opening hours,
 *  never widened by them. A merchant who books 17:00-22:00 on a day the kitchen shuts at
 *  21:00 gets 17:00-21:00 — the closed hour is not offered, because is_branch_open() would
 *  refuse it at submit anyway.
 *
 *  `bookable` null/undefined is a branch that never armed the feature, so opening hours
 *  alone decide. An EMPTY ARRAY is a different answer: armed with no windows all week. */
export function effectiveBookableRanges(
  opening: WeekdayWindow[],
  bookable: WeekdayWindow[] | null | undefined,
  dow: number,
): MinuteRange[] {
  const open = openRangesForDay(opening, dow);
  if (!bookable) return mergeRanges(open);
  return mergeRanges(intersectRanges(open, bookableRangesForDay(bookable, dow)));
}

function to12Hour(minutes: number): string {
  const total = minutes % DAY_MINUTES;
  const h24 = Math.floor(total / 60);
  const suffix = h24 < 12 ? 'AM' : 'PM';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}:${String(total % 60).padStart(2, '0')} ${suffix}`;
}

/** Human-readable ranges for a merchant reading their own week back. Not built with
 *  Intl.DateTimeFormat on purpose: a minute-of-day has no date, and inventing one to format
 *  it would drag the host's timezone into a calculation that has none. */
export function describeRanges(ranges: MinuteRange[], emptyLabel = 'Nothing bookable'): string {
  const merged = mergeRanges(ranges);
  if (merged.length === 0) return emptyLabel;
  return merged
    .map(([start, end]) => `${to12Hour(start)} – ${end >= DAY_MINUTES ? 'midnight' : to12Hour(end)}`)
    .join(', ');
}
