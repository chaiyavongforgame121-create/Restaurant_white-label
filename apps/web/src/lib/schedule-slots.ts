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

import { wallTimeToUtc } from '@favornoms/shared';
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
  /** Branch-local wall time, e.g. "5:30 PM". */
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
  /** Slots falling inside one of these are dropped, matching is_branch_open()'s
   *  `p_at between starts_at and ends_at` — inclusive at both ends. */
  closures?: ClosurePeriod[];
  minLeadMinutes: number;
  maxDays: number;
  slotMinutes: number;
  /** Injected so this is testable and so a single render uses one consistent clock. */
  now?: Date;
}

/** The branch-local calendar date and weekday at a given instant. */
function branchDateParts(date: Date, tz: string): { y: number; m: number; d: number; dow: number } {
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
  const { timezone, openingHours, scheduleWindows, minLeadMinutes, maxDays, slotMinutes } = input;
  const now = input.now ?? new Date();
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

  const timeFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const dayFmt = new Intl.DateTimeFormat('en-US', {
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
        slots.push({ iso: new Date(ms).toISOString(), label: timeFmt.format(new Date(ms)) });
      }
    }
    if (slots.length === 0) continue;

    slots.sort((a, b) => a.iso.localeCompare(b.iso));
    days.push({
      date: iso(parts.y, parts.m, parts.d),
      label: offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : dayFmt.format(probe),
      slots,
    });
  }

  return days;
}
