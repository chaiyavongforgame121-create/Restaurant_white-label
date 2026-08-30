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

export interface OpeningWindow {
  day_of_week: number; // 0 = Sunday, matching Postgres extract(dow)
  opens_at: string; // 'HH:MM'
  closes_at: string; // 'HH:MM'
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
  minLeadMinutes: number;
  maxDays: number;
  slotMinutes: number;
  /** Injected so this is testable and so a single render uses one consistent clock. */
  now?: Date;
}

/** Offset of `tz` from UTC at `date`, in ms. Positive east of Greenwich. */
function zoneOffsetMs(date: Date, tz: string): number {
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
 * Branch-local wall time -> UTC instant.
 *
 * Two passes on purpose. The offset depends on the instant, and the instant is what we are
 * solving for, so a single pass is wrong on the two days a year the zone changes: an 8pm
 * slot the evening after a DST shift lands an hour out. The second pass re-reads the offset
 * at the corrected instant and converges.
 */
function wallTimeToUtc(
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

function hhmmToMinutes(v: string): number {
  const [h, m] = v.split(':');
  return Number(h ?? 0) * 60 + Number(m ?? 0);
}

function iso(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Minute-of-day ranges open on `dow`, in branch-local time.
 *
 *  Mirrors is_branch_open()'s three clauses. An overnight window (closes <= opens, e.g.
 *  22:00-02:00) contributes the evening side to its own day and the morning side to the
 *  following one, which is why the previous day is consulted too. */
function windowsForDay(hours: OpeningWindow[], dow: number): Array<[number, number]> {
  if (hours.length === 0) return [[0, 24 * 60]]; // no hours configured = always open

  const out: Array<[number, number]> = [];
  for (const h of hours) {
    const opens = hhmmToMinutes(h.opens_at);
    const closes = hhmmToMinutes(h.closes_at);
    if (closes > opens) {
      if (h.day_of_week === dow) out.push([opens, closes]);
    } else {
      // Evening side, on the day the window is filed under.
      if (h.day_of_week === dow) out.push([opens, 24 * 60]);
      // Morning side, spilling into the next day.
      if (h.day_of_week === (dow + 6) % 7 && closes > 0) out.push([0, closes]);
    }
  }
  return out;
}

export function buildScheduleDays(input: BuildScheduleInput): ScheduleDay[] {
  const { timezone, openingHours, minLeadMinutes, maxDays, slotMinutes } = input;
  const now = input.now ?? new Date();
  const earliest = now.getTime() + Math.max(0, minLeadMinutes) * 60_000;
  // No upper instant cutoff on purpose. The horizon is a number of branch-local DAYS, and
  // the day loop below already stops at the last of them. A `now + maxDays * 24h` cutoff
  // looks equivalent and is not: with maxDays = 0 it lands exactly on `now`, which threw
  // away every remaining slot today — the opposite of "same-day only".
  const step = Math.max(5, slotMinutes);

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
    const ranges = windowsForDay(openingHours, parts.dow);
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
