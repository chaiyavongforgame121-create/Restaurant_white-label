// What the Scheduled orders and Delivery cards read back to the merchant about when delivery
// runs. Both follow the rule public.is_branch_open_for(branch, 'delivery', at) enforces
// (owner report, 2026-11-16): with "Limit delivery to set hours" on, the Delivery card's windows
// ARE the delivery hours and may lie before opening or after closing; off, delivery follows
// opening hours exactly as pickup does. Kept out of the components so the cases can be tested.

import {
  bookableRangesForDay,
  deliveryRangesForDay,
  effectiveBookableRanges,
  mergeRanges,
  openRangesForDay,
  type MinuteRange,
  type WeekdayWindow,
} from '@favornoms/shared';

/** The parts of `from` that `minus` does not cover, both against the same calendar day. */
export function subtractRanges(from: MinuteRange[], minus: MinuteRange[]): MinuteRange[] {
  let out = mergeRanges(from);
  for (const [cutStart, cutEnd] of mergeRanges(minus)) {
    out = out.flatMap(([start, end]): MinuteRange[] => {
      if (cutEnd <= start || cutStart >= end) return [[start, end]];
      const parts: MinuteRange[] = [];
      if (cutStart > start) parts.push([start, cutStart]);
      if (cutEnd < end) parts.push([cutEnd, end]);
      return parts;
    });
  }
  return out;
}

/** Delivery windows on `dow` that fall outside opening hours, such as 08:00-09:00 at a shop
 *  that opens at 09:00. They are allowed; the card only says so, because those are the minutes
 *  in which delivery can be ordered and pickup cannot. */
export function deliveryOutsideOpening(
  opening: WeekdayWindow[],
  delivery: WeekdayWindow[],
  dow: number,
): MinuteRange[] {
  return subtractRanges(deliveryRangesForDay(opening, delivery, dow), openRangesForDay(opening, dow));
}

/**
 * Why a day's booking windows offer nothing, when they do not:
 *  - 'noWindows'        the day has no booking window of its own or spilled from the day before;
 *  - 'outsideOpening'   delivery hours are off, so opening hours decide, and the windows miss them.
 *                       The fix is the Delivery card's "Limit delivery to set hours";
 *  - 'outsideDelivery'  delivery hours are on and the windows miss those delivery windows.
 */
export type BookingEmptyReason = 'noWindows' | 'outsideOpening' | 'outsideDelivery';

/**
 * Delivery hours on `dow` that a diner cannot book because the booking windows ("Limit the times
 * customers can book") leave them out. The two lists are edited on two cards, and a booking needs
 * both: Thai Burrito moved its morning delivery to 07:00-08:00 while its booking windows still said
 * 08:00-09:00, and the checkout offered only the evening (the owner's report, 2026-11-16). Only
 * meaningful while delivery hours are on: with them off, narrowing opening hours to a few booking
 * windows is what the booking windows are for.
 */
export function deliveryNotBookable(
  delivery: WeekdayWindow[],
  bookable: WeekdayWindow[],
  dow: number,
): MinuteRange[] {
  return subtractRanges(deliveryRangesForDay([], delivery, dow), bookableRangesForDay(bookable, dow));
}

export interface BookingPreview {
  ranges: MinuteRange[];
  empty: BookingEmptyReason | null;
  /** Delivery hours this day's booking windows leave out (deliveryNotBookable); empty while
   *  delivery hours are off. */
  notBookable: MinuteRange[];
}

/**
 * What a diner can book for delivery on `dow`, from the booking windows being edited and the
 * SAVED opening hours and Delivery card switch and windows: the storefront and place-order read
 * the saved ones, so a preview built from anything else would promise times the server refuses.
 * Null when it cannot be told because the hours that decide could not be read (null): the
 * delivery windows while delivery hours are on, opening hours while they are off. Opening hours
 * do not matter while delivery hours are on, so an unread opening week does not hide that one.
 */
export function bookingPreview(
  opening: WeekdayWindow[] | null,
  bookable: WeekdayWindow[],
  dow: number,
  deliveryHoursOn: boolean,
  deliveryWindows: WeekdayWindow[] | null,
): BookingPreview | null {
  if (deliveryHoursOn ? !deliveryWindows : !opening) return null;
  const notBookable = deliveryHoursOn && deliveryWindows ? deliveryNotBookable(deliveryWindows, bookable, dow) : [];
  if (bookableRangesForDay(bookable, dow).length === 0) return { ranges: [], empty: 'noWindows', notBookable };
  const ranges = effectiveBookableRanges(opening ?? [], bookable, dow, deliveryHoursOn ? deliveryWindows : null);
  if (ranges.length > 0) return { ranges, empty: null, notBookable };
  return { ranges, empty: deliveryHoursOn ? 'outsideDelivery' : 'outsideOpening', notBookable };
}
