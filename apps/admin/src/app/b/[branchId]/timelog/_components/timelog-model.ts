// The staff time log: which shifts a date range holds, how long each lasted, and the totals.
//
// Days are the BRANCH's calendar days (YYYY-MM-DD) and `to` is INCLUSIVE, as on Reports. A shift
// belongs to the day it was clocked in on, so a closing shift that ends after midnight stays with
// the evening it started. The calendar arithmetic is the dashboard's (branchDayKey and friends),
// so the time log and the dashboard agree on what "today" means at this branch.

import { branchDayKey, shiftDayKey, startOfBranchDayUtc } from '@favornoms/database/queries';

/** The staff_shifts columns the page reads. */
export const SHIFT_SELECT = 'id, staff_member_id, clocked_in_at, clocked_out_at, notes';

/** The roster columns the page reads, named one by one. staff_roster_read returns every column to
 *  a time-log keeper, pin_hash and permissions included; neither has any business on this page. */
export const STAFF_ROSTER_SELECT = 'id, role, invited_email, user_id, branch_id, status';

export const TIMELOG_PRESETS = ['today', 'week', 'month'] as const;
export type TimelogPreset = (typeof TIMELOG_PRESETS)[number];

/** How many days back each preset reaches, counting today as day one. */
const PRESET_SPAN: Record<TimelogPreset, number> = { today: 1, week: 7, month: 30 };

/** The longest range one page shows; a longer one keeps its end date and is cut at the start. */
export const MAX_RANGE_DAYS = 93;

/** The most shifts one page reads. Past it the page says so rather than showing a partial total
 *  as if it were the whole one. */
export const MAX_SHIFTS = 1000;

/** An open shift this long is most likely a forgotten clock-out, and is flagged. */
export const LONG_SHIFT_MS = 12 * 3600_000;

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface TimelogRange {
  /** Branch-local calendar date, inclusive. */
  from: string;
  /** Branch-local calendar date, inclusive. */
  to: string;
  /** The preset this range is, or null for dates picked by hand. */
  preset: TimelogPreset | null;
  /** The dates asked for spanned more than MAX_RANGE_DAYS and the start was moved up. */
  clamped: boolean;
}

function isIsoDay(value: string | undefined): value is string {
  if (!value || !ISO_DAY.test(value)) return false;
  // 2026-02-31 matches the pattern but is no date.
  const d = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** Inclusive span in days: one day is 1. */
export function spanDays(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000) + 1;
}

export function presetRange(preset: TimelogPreset, today: string): TimelogRange {
  return { from: shiftDayKey(today, -(PRESET_SPAN[preset] - 1)), to: today, preset, clamped: false };
}

/**
 * Tolerant read of the search params: a hand-edited or truncated URL falls back to the last 7
 * days instead of an error. Dates picked in the wrong order are swapped, not refused.
 */
export function parseTimelogRange(input: { range?: string; from?: string; to?: string }, today: string): TimelogRange {
  if (isIsoDay(input.from) && isIsoDay(input.to)) {
    let from = input.from;
    let to = input.to;
    if (from > to) [from, to] = [to, from];
    let clamped = false;
    if (spanDays(from, to) > MAX_RANGE_DAYS) {
      from = shiftDayKey(to, -(MAX_RANGE_DAYS - 1));
      clamped = true;
    }
    const preset = TIMELOG_PRESETS.find((p) => to === today && from === presetRange(p, today).from) ?? null;
    return { from, to, preset, clamped };
  }
  const preset = (TIMELOG_PRESETS as readonly string[]).includes(input.range ?? '') ? (input.range as TimelogPreset) : 'week';
  return presetRange(preset, today);
}

/** The staff filter from the URL: a staff member id, or null for everyone. */
export function parseStaffFilter(raw: string | undefined): string | null {
  return raw && UUID_RE.test(raw) ? raw.toLowerCase() : null;
}

/** The query string for a preset, keeping the staff filter. */
export function presetQuery(preset: TimelogPreset, staff: string | null): string {
  const sp = new URLSearchParams({ range: preset });
  if (staff) sp.set('staff', staff);
  return `?${sp.toString()}`;
}

/** The UTC instants a range covers: [start of `from`, start of the day after `to`). */
export function rangeBoundsUtc(range: Pick<TimelogRange, 'from' | 'to'>, timeZone: string): { startIso: string; endIso: string } {
  return {
    startIso: startOfBranchDayUtc(range.from, timeZone).toISOString(),
    endIso: startOfBranchDayUtc(shiftDayKey(range.to, 1), timeZone).toISOString(),
  };
}

export interface ShiftRow {
  id: string;
  staff_member_id: string;
  clocked_in_at: string;
  clocked_out_at: string | null;
  notes: string | null;
}

export interface TimelogShift extends ShiftRow {
  /** The branch day it was clocked in on. */
  day: string;
  /** The branch day it was clocked out on; null while still open. */
  outDay: string | null;
  open: boolean;
  /** Clock in to clock out, or to now while the shift is open. */
  durationMs: number;
}

/** How long a shift lasted (to `nowMs` while open). Never negative: a clock-out stamped before the
 *  clock-in (an edited row) counts as nothing rather than taking hours off the total. */
export function shiftDurationMs(row: Pick<ShiftRow, 'clocked_in_at' | 'clocked_out_at'>, nowMs: number): number {
  const start = Date.parse(row.clocked_in_at);
  const end = row.clocked_out_at ? Date.parse(row.clocked_out_at) : nowMs;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, end - start);
}

export function toTimelogShift(row: ShiftRow, timeZone: string, nowMs: number): TimelogShift {
  const open = row.clocked_out_at == null;
  return {
    ...row,
    day: branchDayKey(new Date(row.clocked_in_at), timeZone),
    outDay: open ? null : branchDayKey(new Date(row.clocked_out_at as string), timeZone),
    open,
    durationMs: shiftDurationMs(row, nowMs),
  };
}

export interface TimelogDay {
  day: string;
  /** Earliest clock-in first. */
  shifts: TimelogShift[];
  totalMs: number;
}

/** Shifts grouped by the branch day they started on, the newest day first. */
export function groupShiftsByDay(rows: readonly ShiftRow[], timeZone: string, nowMs: number): TimelogDay[] {
  const byDay = new Map<string, TimelogShift[]>();
  for (const row of rows) {
    const shift = toTimelogShift(row, timeZone, nowMs);
    const list = byDay.get(shift.day);
    if (list) list.push(shift);
    else byDay.set(shift.day, [shift]);
  }
  return [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? 1 : a > b ? -1 : 0))
    .map(([day, shifts]) => {
      shifts.sort((a, b) => Date.parse(a.clocked_in_at) - Date.parse(b.clocked_in_at));
      return { day, shifts, totalMs: shifts.reduce((sum, s) => sum + s.durationMs, 0) };
    });
}

export interface PersonTotal {
  staffMemberId: string;
  shifts: number;
  totalMs: number;
}

/** Each person's shifts and time in the range, the most hours first. */
export function totalsByPerson(rows: readonly ShiftRow[], nowMs: number): PersonTotal[] {
  const totals = new Map<string, PersonTotal>();
  for (const row of rows) {
    const t = totals.get(row.staff_member_id) ?? { staffMemberId: row.staff_member_id, shifts: 0, totalMs: 0 };
    t.shifts += 1;
    t.totalMs += shiftDurationMs(row, nowMs);
    totals.set(row.staff_member_id, t);
  }
  return [...totals.values()].sort((a, b) => b.totalMs - a.totalMs || b.shifts - a.shifts);
}

/** Whole hours and minutes of a duration, for "7h 05m". Seconds are dropped, never rounded up. */
export function splitDuration(ms: number): { hours: number; minutes: string } {
  const totalMinutes = Math.floor(Math.max(0, ms) / 60_000);
  return { hours: Math.floor(totalMinutes / 60), minutes: String(totalMinutes % 60).padStart(2, '0') };
}

/** An open shift that has run long enough to be a forgotten clock-out. */
export function isLongOpenShift(row: Pick<ShiftRow, 'clocked_in_at' | 'clocked_out_at'>, nowMs: number): boolean {
  return row.clocked_out_at == null && shiftDurationMs(row, nowMs) >= LONG_SHIFT_MS;
}

export interface RosterMember {
  id: string;
  role: string;
  invited_email: string | null;
  user_id: string | null;
  branch_id: string | null;
  status: string | null;
}

/** What to call a staff member: the address they were invited at, or the viewer's own sign-in
 *  address for their own row. Null when neither is known (the page then says "Unnamed"). */
export function staffName(member: RosterMember | undefined, viewer: { id: string; email?: string | null }): string | null {
  if (!member) return null;
  if (member.invited_email) return member.invited_email;
  if (member.user_id && member.user_id === viewer.id && viewer.email) return viewer.email;
  return null;
}

/** The people the staff filter offers: everyone active at this branch (an owner row and a row with
 *  no branch cover every branch), plus anyone with a shift on screen (suspended or moved since).
 *  A pending invite has never clocked in, so it is left out. */
export function filterableMembers(
  roster: readonly RosterMember[],
  branchId: string,
  shiftMemberIds: Iterable<string>,
): RosterMember[] {
  const withShifts = new Set(shiftMemberIds);
  return roster.filter(
    (m) =>
      withShifts.has(m.id) ||
      (m.status === 'active' && (m.role === 'owner' || m.branch_id === null || m.branch_id === branchId)),
  );
}
