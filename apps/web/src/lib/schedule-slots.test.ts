import { describe, expect, it } from 'vitest';
import { buildScheduleDays, type OpeningWindow } from './schedule-slots';

// These run in whatever zone CI happens to use, which is the point: every assertion is
// about the BRANCH's zone. If the implementation ever falls back to the host clock, the
// Chicago cases below break on a UTC runner.

const base = {
  minLeadMinutes: 0,
  maxDays: 2,
  slotMinutes: 60,
};

/** 2026-08-30 is a Sunday (dow 0). 12:00 UTC = 07:00 Chicago (CDT), 08:00 New York. */
const SUNDAY_NOON_UTC = new Date('2026-08-30T12:00:00Z');

/** The same Sunday at 08:00 in Asia/Bangkok (UTC+7, no DST). */
const BANGKOK_SUNDAY = new Date('2026-08-30T01:00:00Z');

describe('buildScheduleDays', () => {
  it('treats no configured hours as always open, matching is_branch_open', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    expect(days).toHaveLength(1);
    expect(days[0]!.label).toBe('Today');
    // 07:00 Chicago onwards, hourly to midnight => 17 slots (07:00 … 23:00).
    expect(days[0]!.slots).toHaveLength(17);
    expect(days[0]!.slots[0]!.label).toBe('7:00 AM');
    expect(days[0]!.slots.at(-1)!.label).toBe('11:00 PM');
  });

  it('offers only the hours the branch is open on that weekday', () => {
    const hours: OpeningWindow[] = [
      { day_of_week: 0, opens_at: '11:00', closes_at: '14:00' }, // Sunday only
    ];
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: hours,
      now: SUNDAY_NOON_UTC,
      maxDays: 2,
    });
    // Monday and Tuesday have no window, so they are not offered at all.
    expect(days).toHaveLength(1);
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['11:00 AM', '12:00 PM', '1:00 PM']);
  });

  it('splits an overnight window across two days', () => {
    // Sunday 22:00 -> 02:00 Monday.
    const hours: OpeningWindow[] = [{ day_of_week: 0, opens_at: '22:00', closes_at: '02:00' }];
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: hours,
      now: SUNDAY_NOON_UTC,
      maxDays: 2,
    });
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow']);
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['10:00 PM', '11:00 PM']);
    // The morning side belongs to Monday, and stops before 02:00.
    expect(days[1]!.slots.map((s) => s.label)).toEqual(['12:00 AM', '1:00 AM']);
  });

  it('honours the minimum lead time', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
      minLeadMinutes: 4 * 60, // earliest is 11:00 Chicago
    });
    expect(days[0]!.slots[0]!.label).toBe('11:00 AM');
  });

  it('honours the maximum horizon', () => {
    const oneDay = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 1,
    });
    expect(oneDay.map((d) => d.label)).toEqual(['Today', 'Tomorrow']);
  });

  it('labels times in the branch zone, not the caller zone', () => {
    const chicago = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    const newYork = buildScheduleDays({
      ...base,
      timezone: 'America/New_York',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    // Same instant, one hour apart on the wall clock.
    expect(chicago[0]!.slots[0]!.label).toBe('7:00 AM');
    expect(newYork[0]!.slots[0]!.label).toBe('8:00 AM');
    // ...and the instant actually sent is identical, which is what the server compares.
    expect(chicago[0]!.slots[0]!.iso).toBe('2026-08-30T12:00:00.000Z');
    expect(newYork[0]!.slots[0]!.iso).toBe('2026-08-30T12:00:00.000Z');
  });

  it('starts slots on a boundary rather than on the branch opening minute', () => {
    const hours: OpeningWindow[] = [{ day_of_week: 0, opens_at: '11:20', closes_at: '13:00' }];
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: hours,
      now: SUNDAY_NOON_UTC,
      slotMinutes: 30,
      maxDays: 0,
    });
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['11:30 AM', '12:00 PM', '12:30 PM']);
  });

  it('does not emit a slot twice when two windows overlap', () => {
    const hours: OpeningWindow[] = [
      { day_of_week: 0, opens_at: '11:00', closes_at: '14:00' },
      { day_of_week: 0, opens_at: '12:00', closes_at: '15:00' },
    ];
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: hours,
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    const labels = days[0]!.slots.map((s) => s.label);
    expect(labels).toEqual(['11:00 AM', '12:00 PM', '1:00 PM', '2:00 PM']);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('keeps wall time correct across a DST transition', () => {
    // US DST ends Sunday 2026-11-01. A slot the following evening must still read 6:00 PM
    // local, which a single-pass offset calculation gets wrong by an hour.
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [{ day_of_week: 1, opens_at: '18:00', closes_at: '19:00' }], // Monday
      now: new Date('2026-10-31T12:00:00Z'), // Saturday
      maxDays: 3,
      slotMinutes: 60,
    });
    const monday = days.find((d) => d.date === '2026-11-02');
    expect(monday).toBeDefined();
    expect(monday!.slots.map((s) => s.label)).toEqual(['6:00 PM']);
    // 18:00 CST (UTC-6) => 00:00 UTC the next day.
    expect(monday!.slots[0]!.iso).toBe('2026-11-03T00:00:00.000Z');
  });
});

// The bookable window (branch_schedule_hours) sits on top of opening hours: a shop can be
// open all day and still only take pre-orders in a narrower band, per weekday.
describe('buildScheduleDays with bookable windows', () => {
  it('leaves the slot list untouched when the merchant never armed the feature', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      scheduleWindows: null,
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    // Identical to the "no configured hours" case above — the feature is inert by default.
    expect(days[0]!.slots).toHaveLength(17);
    expect(days[0]!.slots[0]!.label).toBe('7:00 AM');
  });

  it('offers nothing on a weekday with no bookable window', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [], // open all week
      scheduleWindows: [{ day_of_week: 0, opens_at: '10:00', closes_at: '14:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 2,
    });
    // Monday and Tuesday are open but not bookable, so they are not offered at all.
    expect(days.map((d) => d.label)).toEqual(['Today']);
    expect(days[0]!.slots.map((s) => s.label)).toEqual([
      '10:00 AM',
      '11:00 AM',
      '12:00 PM',
      '1:00 PM',
    ]);
  });

  it("expresses the owner's case in Asia/Bangkok: daily from 5pm, Sundays 10am-2pm", () => {
    const windows: OpeningWindow[] = [
      { day_of_week: 0, opens_at: '10:00', closes_at: '14:00' },
      ...[1, 2, 3, 4, 5, 6].map((d) => ({
        day_of_week: d,
        opens_at: '17:00',
        closes_at: '22:00',
      })),
    ];
    const days = buildScheduleDays({
      ...base,
      timezone: 'Asia/Bangkok',
      openingHours: [], // the shop itself is open every day
      scheduleWindows: windows,
      now: BANGKOK_SUNDAY,
      maxDays: 1,
      slotMinutes: 60,
    });
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow']);
    expect(days[0]!.slots.map((s) => s.label)).toEqual([
      '10:00 AM',
      '11:00 AM',
      '12:00 PM',
      '1:00 PM',
    ]);
    expect(days[1]!.slots.map((s) => s.label)).toEqual([
      '5:00 PM',
      '6:00 PM',
      '7:00 PM',
      '8:00 PM',
      '9:00 PM',
    ]);
    // The whole Bangkok-drift guard in one assertion: 10:00 ICT is 03:00 UTC, and that is
    // the instant place-order re-judges with `p_at at time zone branches.timezone`. A host
    // clock or a UTC weekday leaking in moves this by seven hours.
    expect(days[0]!.slots[0]!.iso).toBe('2026-08-30T03:00:00.000Z');
  });

  it('cannot extend bookable times past the hours the branch is open', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [{ day_of_week: 0, opens_at: '10:00', closes_at: '21:00' }],
      scheduleWindows: [{ day_of_week: 0, opens_at: '17:00', closes_at: '23:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
      slotMinutes: 60,
    });
    // 21:00-23:00 is bookable on paper and shut in practice, so it is not offered.
    expect(days[0]!.slots.map((s) => s.label)).toEqual([
      '5:00 PM',
      '6:00 PM',
      '7:00 PM',
      '8:00 PM',
    ]);
  });

  it('drops slots inside a branch closure instead of offering a 409', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
      // 12:00-13:00 Chicago (CDT, UTC-5) on that Sunday.
      closures: [{ starts_at: '2026-08-30T17:00:00Z', ends_at: '2026-08-30T18:00:00Z' }],
    });
    const labels = days[0]!.slots.map((s) => s.label);
    expect(labels).toContain('11:00 AM');
    expect(labels).toContain('2:00 PM');
    // Inclusive at both ends, exactly as is_branch_open()'s `between` is.
    expect(labels).not.toContain('12:00 PM');
    expect(labels).not.toContain('1:00 PM');
  });

  it('offers nothing at all when armed with an empty week', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      scheduleWindows: [], // armed, no windows — NOT the same as null
      now: SUNDAY_NOON_UTC,
      maxDays: 2,
    });
    expect(days).toEqual([]);
  });
});
