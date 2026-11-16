import { describe, expect, it } from 'vitest';
import type { WeekdayWindow } from '@favornoms/shared';
import { bookingPreview, deliveryOutsideOpening, subtractRanges } from './delivery-hours-model';

const everyDay = (opens_at: string, closes_at: string): WeekdayWindow[] =>
  Array.from({ length: 7 }, (_, day_of_week) => ({ day_of_week, opens_at, closes_at }));

// The owner's report of 2026-11-16: open 09:00-17:30 every day, delivering only 08:00-09:00
// and 18:00-19:00.
const opening = everyDay('09:00', '17:30');
const deliveryWindows = [...everyDay('08:00', '09:00'), ...everyDay('18:00', '19:00')];
const bookingWindows = [...everyDay('08:00', '09:00'), ...everyDay('18:00', '19:00')];
const MONDAY = 1;

describe('subtractRanges', () => {
  it('keeps what the cut does not touch and splits around what it does', () => {
    expect(subtractRanges([[480, 1140]], [[540, 1050]])).toEqual([
      [480, 540],
      [1050, 1140],
    ]);
    expect(subtractRanges([[480, 540]], [[540, 1050]])).toEqual([[480, 540]]);
    expect(subtractRanges([[600, 700]], [[540, 1050]])).toEqual([]);
    expect(subtractRanges([[600, 700]], [])).toEqual([[600, 700]]);
  });
});

describe('deliveryOutsideOpening', () => {
  it('names the delivery windows before opening and after closing', () => {
    expect(deliveryOutsideOpening(opening, deliveryWindows, MONDAY)).toEqual([
      [480, 540],
      [1080, 1140],
    ]);
  });

  it('is empty when delivery sits inside opening hours', () => {
    expect(deliveryOutsideOpening(opening, everyDay('11:00', '14:00'), MONDAY)).toEqual([]);
  });

  it('is empty for a branch with no opening hours, which is always open', () => {
    expect(deliveryOutsideOpening([], deliveryWindows, MONDAY)).toEqual([]);
  });

  it('covers a day the shop is shut but still delivers', () => {
    const weekdaysOnly = opening.filter((w) => w.day_of_week !== 0);
    expect(deliveryOutsideOpening(weekdaysOnly, deliveryWindows, 0)).toEqual([
      [480, 540],
      [1080, 1140],
    ]);
  });
});

describe('bookingPreview', () => {
  it('offers the delivery windows when delivery hours are on, opening hours or not', () => {
    expect(bookingPreview(opening, bookingWindows, MONDAY, true, deliveryWindows)).toEqual({
      ranges: [
        [480, 540],
        [1080, 1140],
      ],
      empty: null,
    });
  });

  it('says the fix when delivery hours are off and the windows miss opening hours', () => {
    expect(bookingPreview(opening, bookingWindows, MONDAY, false, deliveryWindows)).toEqual({
      ranges: [],
      empty: 'outsideOpening',
    });
  });

  it('ignores saved delivery windows while delivery hours are off', () => {
    expect(bookingPreview(opening, everyDay('10:00', '12:00'), MONDAY, false, deliveryWindows)).toEqual({
      ranges: [[600, 720]],
      empty: null,
    });
  });

  it('blames the delivery windows when they are on and the booking windows miss them', () => {
    expect(bookingPreview(opening, everyDay('10:00', '12:00'), MONDAY, true, deliveryWindows)).toEqual({
      ranges: [],
      empty: 'outsideDelivery',
    });
  });

  it('narrows the booking windows by the delivery windows, never widens them', () => {
    expect(bookingPreview(opening, everyDay('18:30', '22:00'), MONDAY, true, deliveryWindows)).toEqual({
      ranges: [[1110, 1140]],
      empty: null,
    });
  });

  it('cannot tell while delivery hours are on and their windows were not read', () => {
    expect(bookingPreview(opening, bookingWindows, MONDAY, true, null)).toBeNull();
  });

  it('cannot tell while delivery hours are off and opening hours were not read', () => {
    // Not "always open": an unread week is not an empty one.
    expect(bookingPreview(null, bookingWindows, MONDAY, false, deliveryWindows)).toBeNull();
  });

  it('still previews from the delivery windows when only opening hours were not read', () => {
    expect(bookingPreview(null, bookingWindows, MONDAY, true, deliveryWindows)).toEqual({
      ranges: [
        [480, 540],
        [1080, 1140],
      ],
      empty: null,
    });
  });

  it('follows the opening hours it is handed, so a saved change moves the preview', () => {
    // 09:00-17:30 widened to 08:00-19:00: the 08:00 and 18:00 bookings now fall inside them.
    expect(bookingPreview(everyDay('08:00', '19:00'), bookingWindows, MONDAY, false, null)).toEqual({
      ranges: [
        [480, 540],
        [1080, 1140],
      ],
      empty: null,
    });
  });

  it('reads delivery hours switched on with no windows as no delivery', () => {
    expect(bookingPreview(opening, bookingWindows, MONDAY, true, [])).toEqual({
      ranges: [],
      empty: 'outsideDelivery',
    });
  });

  it('marks a day with no booking window of its own', () => {
    const sundayOnly = everyDay('18:00', '19:00').filter((w) => w.day_of_week === 0);
    expect(bookingPreview(opening, sundayOnly, MONDAY, true, deliveryWindows)).toEqual({
      ranges: [],
      empty: 'noWindows',
    });
  });

  it('counts the tail of the previous evening as a window of this day', () => {
    const lateSunday: WeekdayWindow[] = [{ day_of_week: 0, opens_at: '22:00', closes_at: '02:00' }];
    expect(bookingPreview([], lateSunday, MONDAY, false, null)).toEqual({ ranges: [[0, 120]], empty: null });
  });
});
