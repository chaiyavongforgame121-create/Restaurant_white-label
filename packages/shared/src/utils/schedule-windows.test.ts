import { describe, expect, it } from 'vitest';
import {
  bookableRangesForDay,
  deliveryRangesForDay,
  describeRanges,
  effectiveBookableRanges,
  intersectRanges,
  mergeRanges,
  minutesFromHHMM,
  minutesToHHMM,
  openRangesForDay,
  type WeekdayWindow,
} from './schedule-windows';

/**
 * The two readings of the same rows are the whole point of this module, so most of what is
 * pinned here is the difference between them: branch_hours with no rows is "always open",
 * branch_schedule_hours with no rows is "nothing bookable". Getting those the wrong way
 * round would either stop every branch taking orders or let every branch take bookings the
 * merchant meant to refuse.
 */

const SUN = 0;
const MON = 1;
const SAT = 6;

describe('minutesFromHHMM / minutesToHHMM', () => {
  it('round-trips a wall time', () => {
    expect(minutesFromHHMM('17:30')).toBe(17 * 60 + 30);
    expect(minutesToHHMM(17 * 60 + 30)).toBe('17:30');
  });

  it('reads a Postgres time column, which arrives with seconds', () => {
    expect(minutesFromHHMM('09:05:00')).toBe(9 * 60 + 5);
  });
});

describe('openRangesForDay', () => {
  it('treats no rows as always open, matching is_branch_open', () => {
    expect(openRangesForDay([], MON)).toEqual([[0, 1440]]);
  });

  it('returns only the windows filed under that weekday', () => {
    const hours: WeekdayWindow[] = [
      { day_of_week: SUN, opens_at: '10:00', closes_at: '14:00' },
      { day_of_week: MON, opens_at: '17:00', closes_at: '22:00' },
    ];
    expect(openRangesForDay(hours, SUN)).toEqual([[600, 840]]);
    expect(openRangesForDay(hours, MON)).toEqual([[1020, 1320]]);
  });

  it('splits an overnight window across both days', () => {
    const hours: WeekdayWindow[] = [{ day_of_week: SAT, opens_at: '22:00', closes_at: '02:00' }];
    expect(openRangesForDay(hours, SAT)).toEqual([[1320, 1440]]);
    expect(openRangesForDay(hours, SUN)).toEqual([[0, 120]]);
  });
});

describe('bookableRangesForDay', () => {
  it('fails CLOSED on an empty week, unlike opening hours', () => {
    expect(bookableRangesForDay([], MON)).toEqual([]);
    expect(openRangesForDay([], MON)).toEqual([[0, 1440]]);
  });

  it('offers nothing on a weekday with no window', () => {
    const windows: WeekdayWindow[] = [{ day_of_week: SUN, opens_at: '10:00', closes_at: '14:00' }];
    expect(bookableRangesForDay(windows, SUN)).toEqual([[600, 840]]);
    expect(bookableRangesForDay(windows, MON)).toEqual([]);
  });
});

describe('intersectRanges', () => {
  it('keeps only the overlap', () => {
    expect(
      intersectRanges(
        [
          [600, 1260],
          [1300, 1400],
        ],
        [[1000, 1320]],
      ),
    ).toEqual([
      [1000, 1260],
      [1300, 1320],
    ]);
  });

  it('drops a touching-but-not-overlapping pair rather than emitting a zero-width range', () => {
    expect(intersectRanges([[600, 840]], [[840, 900]])).toEqual([]);
  });
});

describe('mergeRanges', () => {
  it('collapses overlapping windows a merchant may legitimately have saved', () => {
    expect(
      mergeRanges([
        [720, 900],
        [660, 840],
      ]),
    ).toEqual([[660, 900]]);
  });
});

describe('effectiveBookableRanges', () => {
  const opening: WeekdayWindow[] = [
    { day_of_week: SUN, opens_at: '10:00', closes_at: '21:00' },
    { day_of_week: MON, opens_at: '10:00', closes_at: '21:00' },
  ];

  it('leaves opening hours alone when the merchant never armed the feature', () => {
    expect(effectiveBookableRanges(opening, null, MON)).toEqual([[600, 1260]]);
  });

  it('narrows to the booking window', () => {
    const windows: WeekdayWindow[] = [{ day_of_week: MON, opens_at: '17:00', closes_at: '22:00' }];
    // 22:00 is past the 21:00 close, so the shut hour is not on offer.
    expect(effectiveBookableRanges(opening, windows, MON)).toEqual([[1020, 1260]]);
  });

  it('never extends past opening hours, even for a window entirely outside them', () => {
    const windows: WeekdayWindow[] = [{ day_of_week: MON, opens_at: '22:00', closes_at: '23:30' }];
    expect(effectiveBookableRanges(opening, windows, MON)).toEqual([]);
  });

  it("expresses the owner's case: daily from 17:00, Sunday 10:00-14:00 only", () => {
    const alwaysOpen: WeekdayWindow[] = [];
    const windows: WeekdayWindow[] = [
      { day_of_week: SUN, opens_at: '10:00', closes_at: '14:00' },
      ...[1, 2, 3, 4, 5, 6].map((d) => ({
        day_of_week: d,
        opens_at: '17:00',
        closes_at: '22:00',
      })),
    ];
    expect(effectiveBookableRanges(alwaysOpen, windows, SUN)).toEqual([[600, 840]]);
    expect(effectiveBookableRanges(alwaysOpen, windows, MON)).toEqual([[1020, 1320]]);
  });
});

describe('deliveryRangesForDay', () => {
  // Thai Burrito (2026-11-16): open 09:00-17:30, delivering 08:00-09:00 and 18:00-19:00.
  const opening: WeekdayWindow[] = [{ day_of_week: MON, opens_at: '09:00', closes_at: '17:30' }];
  const delivery: WeekdayWindow[] = [
    { day_of_week: MON, opens_at: '08:00', closes_at: '09:00' },
    { day_of_week: MON, opens_at: '18:00', closes_at: '19:00' },
  ];

  it('follows opening hours while delivery hours are switched off', () => {
    expect(deliveryRangesForDay(opening, null, MON)).toEqual([[540, 1050]]);
    expect(deliveryRangesForDay(opening, undefined, MON)).toEqual([[540, 1050]]);
    expect(deliveryRangesForDay([], null, MON)).toEqual([[0, 1440]]);
  });

  it('takes the delivery windows on their own when switched on, outside opening hours too', () => {
    expect(deliveryRangesForDay(opening, delivery, MON)).toEqual([[480, 540], [1080, 1140]]);
    // Not widened back to "always" by a branch with no opening hours, nor narrowed by them.
    expect(deliveryRangesForDay([], delivery, MON)).toEqual([[480, 540], [1080, 1140]]);
  });

  it('delivers nothing on a day the switched-on week leaves empty', () => {
    expect(deliveryRangesForDay(opening, delivery, SUN)).toEqual([]);
    expect(deliveryRangesForDay(opening, [], MON)).toEqual([]);
  });

  it('spills an overnight delivery window into the next morning', () => {
    const late: WeekdayWindow[] = [{ day_of_week: SAT, opens_at: '22:00', closes_at: '02:00' }];
    expect(deliveryRangesForDay(opening, late, SAT)).toEqual([[1320, 1440]]);
    expect(deliveryRangesForDay(opening, late, SUN)).toEqual([[0, 120]]);
  });

  it('lets booking windows outside opening hours book delivery once delivery hours cover them', () => {
    expect(effectiveBookableRanges(opening, delivery, MON)).toEqual([]);
    expect(effectiveBookableRanges(opening, delivery, MON, delivery)).toEqual([[480, 540], [1080, 1140]]);
    expect(effectiveBookableRanges(opening, null, MON, delivery)).toEqual([[480, 540], [1080, 1140]]);
    expect(
      effectiveBookableRanges(opening, [{ day_of_week: MON, opens_at: '08:30', closes_at: '18:30' }], MON, delivery),
    ).toEqual([[510, 540], [1080, 1110]]);
  });
});

describe('describeRanges', () => {
  it('reads back as wall-clock times', () => {
    expect(describeRanges([[1020, 1320]])).toBe('5:00 PM – 10:00 PM');
    expect(describeRanges([[600, 840]])).toBe('10:00 AM – 2:00 PM');
  });

  it('names midnight rather than printing 12:00 AM for a day that runs out', () => {
    expect(describeRanges([[1320, 1440]])).toBe('10:00 PM – midnight');
  });

  it('falls back to the callers label when there is nothing to book', () => {
    expect(describeRanges([], 'Closed')).toBe('Closed');
  });
});
