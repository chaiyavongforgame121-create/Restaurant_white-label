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

describe('buildScheduleDays — delivery hours', () => {
  const sundayNineToSix: OpeningWindow[] = [{ day_of_week: 0, opens_at: '09:00', closes_at: '18:00' }];

  it('narrows a delivery booking to the delivery windows', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: sundayNineToSix,
      deliveryWindows: [{ day_of_week: 0, opens_at: '11:00', closes_at: '13:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['11:00 AM', '12:00 PM']);
  });

  it('offers nothing when delivery hours are switched on with no windows', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: sundayNineToSix,
      deliveryWindows: [],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    expect(days).toEqual([]);
  });

  it('leaves opening hours alone when delivery hours are not restricted', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: sundayNineToSix,
      deliveryWindows: null,
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    // 09:00 … 17:00 hourly.
    expect(days[0]!.slots).toHaveLength(9);
  });

  it('applies booking windows and delivery hours together', () => {
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [{ day_of_week: 0, opens_at: '09:00', closes_at: '20:00' }],
      scheduleWindows: [
        { day_of_week: 0, opens_at: '11:00', closes_at: '13:00' },
        { day_of_week: 0, opens_at: '17:00', closes_at: '19:00' },
      ],
      deliveryWindows: [{ day_of_week: 0, opens_at: '12:00', closes_at: '18:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['12:00 PM', '5:00 PM']);
  });

  it('books delivery hours that run past closing time, which the server now accepts', () => {
    // Open 09:00-18:00; delivering 16:00-20:00 offers 4 PM … 7 PM, the last two after closing.
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: sundayNineToSix,
      deliveryWindows: [{ day_of_week: 0, opens_at: '16:00', closes_at: '20:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 0,
    });
    expect(days[0]!.slots.map((s) => s.label)).toEqual(['4:00 PM', '5:00 PM', '6:00 PM', '7:00 PM']);
  });

  it('follows an overnight delivery window into the next morning, like is_delivery_available', () => {
    // Sunday 22:00 -> Monday 02:00; opening hours unrestricted.
    const days = buildScheduleDays({
      ...base,
      timezone: 'America/Chicago',
      openingHours: [],
      deliveryWindows: [{ day_of_week: 0, opens_at: '22:00', closes_at: '02:00' }],
      now: SUNDAY_NOON_UTC,
      maxDays: 1,
    });
    expect(days.map((d) => d.slots.map((s) => s.label))).toEqual([
      ['10:00 PM', '11:00 PM'],
      ['12:00 AM', '1:00 AM'],
    ]);
  });
});

// The owner's report of 2026-11-16, from Thai Burrito (America/Chicago): open 09:00-17:30 every
// day, delivering only 08:00-09:00 and 18:00-19:00. Every reading used to start from opening hours
// and narrow, so windows outside them left nothing to book. Delivery hours now stand on their own.
describe('buildScheduleDays — Thai Burrito, delivery outside opening hours', () => {
  const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
  const opening: OpeningWindow[] = EVERY_DAY.map((d) => ({
    day_of_week: d,
    opens_at: '09:00',
    closes_at: '17:30',
  }));
  const delivery: OpeningWindow[] = EVERY_DAY.flatMap((d) => [
    { day_of_week: d, opens_at: '08:00', closes_at: '09:00' },
    { day_of_week: d, opens_at: '18:00', closes_at: '19:00' },
  ]);
  /** Monday 2026-11-16, 06:00 in Chicago (CST, UTC-6): before either window opens. */
  const MONDAY_6AM_CHICAGO = new Date('2026-11-16T12:00:00Z');
  const week = {
    timezone: 'America/Chicago',
    openingHours: opening,
    minLeadMinutes: 0,
    maxDays: 6,
    slotMinutes: 30,
    now: MONDAY_6AM_CHICAGO,
  };
  const DELIVERY_SLOTS = ['8:00 AM', '8:30 AM', '6:00 PM', '6:30 PM'];

  it('with delivery hours on, offers 08:00-09:00 and 18:00-19:00 every day of the week, and nothing else', () => {
    const days = buildScheduleDays({ ...week, deliveryWindows: delivery });
    expect(days.map((d) => d.date)).toEqual([
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
      '2026-11-20',
      '2026-11-21',
      '2026-11-22',
    ]);
    for (const day of days) expect(day.slots.map((s) => s.label)).toEqual(DELIVERY_SLOTS);
    // The instants place-order is sent: 08:00 CST is 14:00 UTC, and 18:00 CST is midnight UTC
    // the next day — which must still be filed under Monday, the branch's day.
    expect(days[0]!.slots.map((s) => s.iso)).toEqual([
      '2026-11-16T14:00:00.000Z',
      '2026-11-16T14:30:00.000Z',
      '2026-11-17T00:00:00.000Z',
      '2026-11-17T00:30:00.000Z',
    ]);
  });

  it('with delivery hours off, offers opening hours only — none of the delivery windows', () => {
    const days = buildScheduleDays({ ...week, deliveryWindows: null });
    expect(days).toHaveLength(7);
    for (const day of days) {
      const labels = day.slots.map((s) => s.label);
      expect(labels[0]).toBe('9:00 AM');
      expect(labels.at(-1)).toBe('5:00 PM');
      expect(labels).toHaveLength(17); // 09:00 … 17:00, every 30 minutes
      for (const slot of DELIVERY_SLOTS) expect(labels).not.toContain(slot);
    }
  });

  it('booking windows on the delivery hours book them only while delivery hours are on', () => {
    // What the merchant tried first: "Limit the times customers can book" set to the delivery
    // windows. Narrowing opening hours, they left nothing; narrowing delivery's own hours, they fit.
    const on = buildScheduleDays({ ...week, scheduleWindows: delivery, deliveryWindows: delivery });
    expect(on).toHaveLength(7);
    for (const day of on) expect(day.slots.map((s) => s.label)).toEqual(DELIVERY_SLOTS);
    expect(buildScheduleDays({ ...week, scheduleWindows: delivery, deliveryWindows: null })).toEqual([]);
  });

  it('still drops a closure and honours the lead time inside delivery hours', () => {
    const days = buildScheduleDays({
      ...week,
      deliveryWindows: delivery,
      // From 06:00, a 3-hour lead starts at 09:00: Monday's evening window only.
      minLeadMinutes: 180,
      // Tuesday 18:00-18:30 Chicago (inclusive at both ends, as the server reads it).
      closures: [{ starts_at: '2026-11-18T00:00:00Z', ends_at: '2026-11-18T00:30:00Z' }],
      maxDays: 1,
    });
    expect(days.map((d) => d.slots.map((s) => s.label))).toEqual([
      ['6:00 PM', '6:30 PM'],
      ['8:00 AM', '8:30 AM'],
    ]);
  });
});

// The labels follow the interface language; nothing else may. A diner reading the slots in
// Thai must be booking exactly the instants an English reader would.
describe('buildScheduleDays — interface language', () => {
  const allWeek = {
    ...base,
    timezone: 'America/Chicago',
    openingHours: [] as OpeningWindow[],
    now: SUNDAY_NOON_UTC,
    maxDays: 2,
  };

  it('writes English when no locale is given, as before', () => {
    const days = buildScheduleDays(allWeek);
    expect(days.map((d) => d.label)).toEqual(['Today', 'Tomorrow', 'Tue, Sep 1']);
    expect(days[0]!.slots[0]!.label).toBe('7:00 AM');
    expect(buildScheduleDays({ ...allWeek, locale: 'en' })).toEqual(days);
  });

  it('uses the day words the caller passes for today and tomorrow', () => {
    const days = buildScheduleDays({
      ...allWeek,
      locale: 'es',
      dayLabels: { today: 'Hoy', tomorrow: 'Mañana' },
    });
    expect(days[0]!.label).toBe('Hoy');
    expect(days[1]!.label).toBe('Mañana');
    // The third day is dated in Spanish, not in English.
    expect(days[2]!.label).not.toBe('Tue, Sep 1');
    expect(days[2]!.label).toContain('1');
  });

  it('reads the 12-hour clock in Spanish and the 24-hour clock in Vietnamese and Thai', () => {
    const at = (locale: 'es' | 'vi' | 'th') =>
      buildScheduleDays({ ...allWeek, locale, maxDays: 0 })[0]!.slots.map((s) => s.label);
    const es = at('es');
    expect(es[0]).toBe('7:00 a. m.');
    expect(es.at(-1)).toBe('11:00 p. m.');
    expect(at('vi')[0]).toBe('07:00');
    expect(at('vi').at(-1)).toBe('23:00');
    expect(at('th')[0]).toBe('07:00 น.');
    expect(at('th').at(-1)).toBe('23:00 น.');
  });

  it('offers the same instants in every language', () => {
    const isoList = (locale?: 'en' | 'es' | 'vi' | 'th') =>
      buildScheduleDays({ ...allWeek, locale }).map((d) => [d.date, d.slots.map((s) => s.iso)]);
    const english = isoList();
    expect(isoList('es')).toEqual(english);
    expect(isoList('vi')).toEqual(english);
    expect(isoList('th')).toEqual(english);
  });

  it('falls back to English for a value that is not an interface language', () => {
    const days = buildScheduleDays({ ...allWeek, locale: 'fr' as never, maxDays: 0 });
    expect(days[0]!.slots[0]!.label).toBe('7:00 AM');
  });
});
