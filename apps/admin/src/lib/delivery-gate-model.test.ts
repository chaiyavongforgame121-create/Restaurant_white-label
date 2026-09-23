import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entitlements } from '@favornoms/shared';
import {
  deliveryOneTimePrice,
  navEntryAllowed,
  NO_WIND_DOWN,
  oneTimePriceToShow,
  payoutWindowStart,
  PAYOUT_SUMMARY_WEEKS,
  type DeliveryWindDown,
  type GatedEntry,
} from './delivery-gate-model';

const LOCALES = ['en', 'es', 'th', 'vi'] as const;

function messages(locale: string, ns: string): Record<string, unknown> {
  const file = path.resolve(__dirname, '../../messages', locale, `${ns}.json`);
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

/** A live, paid-up payload resolved for one branch; `delivers` is that branch's switch. */
function ent(delivers: boolean): Entitlements {
  return {
    entitled: true,
    features: { card_payment: true, delivery: delivers },
  } as unknown as Entitlements;
}

// The three delivery entries exactly as the sidebar declares them.
const BOARD: GatedEntry = { feature: 'delivery', windDown: 'runsOut' };
const PAYOUTS: GatedEntry = { feature: 'delivery', windDown: 'ridersOwed' };
const DRIVERS: GatedEntry = { feature: 'delivery' };

describe('navEntryAllowed — a delivery entry is shown exactly while its screen is open', () => {
  const runsOut: DeliveryWindDown = { runsOut: true, ridersOwed: false };
  const owed: DeliveryWindDown = { runsOut: false, ridersOwed: true };

  it('shows all three at a branch that delivers', () => {
    for (const e of [BOARD, PAYOUTS, DRIVERS]) expect(navEntryAllowed(e, ent(true), NO_WIND_DOWN)).toBe(true);
  });

  it('hides all three once delivery is off and nothing is outstanding', () => {
    for (const e of [BOARD, PAYOUTS, DRIVERS]) expect(navEntryAllowed(e, ent(false), NO_WIND_DOWN)).toBe(false);
  });

  it('keeps the Live deliveries board (only) while runs are still out', () => {
    // DELIV-4: the board stays open for in-flight runs, so its entry must too.
    expect(navEntryAllowed(BOARD, ent(false), runsOut)).toBe(true);
    expect(navEntryAllowed(PAYOUTS, ent(false), runsOut)).toBe(false);
    expect(navEntryAllowed(DRIVERS, ent(false), runsOut)).toBe(false);
  });

  it('keeps Driver payouts (only) while a rider is still owed', () => {
    // Before, one "unfinished work" flag also showed Live deliveries and Drivers here, and both
    // of those pages are locked in this state.
    expect(navEntryAllowed(PAYOUTS, ent(false), owed)).toBe(true);
    expect(navEntryAllowed(BOARD, ent(false), owed)).toBe(false);
    expect(navEntryAllowed(DRIVERS, ent(false), owed)).toBe(false);
  });

  it('never lets a wind-down flag open anything but delivery entries', () => {
    const everything: DeliveryWindDown = { runsOut: true, ridersOwed: true };
    expect(navEntryAllowed({ feature: 'digital_signage' }, ent(false), everything)).toBe(false);
    expect(navEntryAllowed({}, ent(false), NO_WIND_DOWN)).toBe(true);
  });

  it('fails closed on a lapsed or missing payload, wind-down aside', () => {
    const lapsed = { entitled: false, features: { delivery: true } } as unknown as Entitlements;
    expect(navEntryAllowed(DRIVERS, lapsed, NO_WIND_DOWN)).toBe(false);
    expect(navEntryAllowed(DRIVERS, null, NO_WIND_DOWN)).toBe(false);
    expect(navEntryAllowed(BOARD, null, { runsOut: true, ridersOwed: false })).toBe(true);
  });
});

describe('deliveryOneTimePrice — PKG-04: a paid unlock is never quoted again', () => {
  it('quotes the catalog price at a branch that never unlocked delivery', () => {
    expect(deliveryOneTimePrice(59, false)).toBe(59);
  });

  it('quotes nothing once at a branch whose unlock was already paid', () => {
    // Coastal Grill's Hamburger switched delivery off with its $59 paid: back on is $0 once.
    expect(deliveryOneTimePrice(59, true)).toBe(0);
  });

  it('guesses neither $59 nor $0 when the unlock or the catalog could not be read', () => {
    expect(deliveryOneTimePrice(59, null)).toBeNull();
    expect(deliveryOneTimePrice(null, false)).toBeNull();
    expect(deliveryOneTimePrice(null, true)).toBeNull();
  });

  it('prints a positive price, and leaves 0 or unknown out rather than showing "$0 once"', () => {
    expect(oneTimePriceToShow(59)).toBe(59);
    expect(oneTimePriceToShow(0)).toBeUndefined();
    expect(oneTimePriceToShow(null)).toBeUndefined();
  });
});

describe('payoutWindowStart — the same first week get_branch_payout_summary lists', () => {
  // SQL: date_trunc('week', now())::date - (p_weeks * 7), in UTC. On 2026-09-23 the live
  // database answered 2026-07-27 for p_weeks = 8.
  it('matches the database on the day it was checked', () => {
    expect(PAYOUT_SUMMARY_WEEKS).toBe(8);
    expect(payoutWindowStart(new Date('2026-09-23T14:00:13Z'))).toBe('2026-07-27');
  });

  it('starts every day of a week from that week’s Monday, Sunday included', () => {
    expect(payoutWindowStart(new Date('2026-09-21T00:00:00Z'))).toBe('2026-07-27'); // Monday
    expect(payoutWindowStart(new Date('2026-09-27T23:59:59Z'))).toBe('2026-07-27'); // Sunday
    expect(payoutWindowStart(new Date('2026-09-28T00:00:00Z'))).toBe('2026-08-03'); // next Monday
  });

  it('reads the instant in UTC, as the database session does', () => {
    // 23:30 on Sunday in New York is already Monday in UTC.
    expect(payoutWindowStart(new Date('2026-09-27T23:30:00-04:00'))).toBe('2026-08-03');
  });

  it('never asks for fewer than one week, like greatest(p_weeks, 1)', () => {
    expect(payoutWindowStart(new Date('2026-09-23T12:00:00Z'), 0)).toBe('2026-09-14');
  });
});

describe('the words the locked delivery screens use, in every language', () => {
  for (const locale of LOCALES) {
    it(`${locale}: says an unlocked branch pays nothing once, naming the branch`, () => {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
      expect(locked.deliveryUnlockedAtThisBranch).toContain('{branch}');
      expect(locked.deliveryUnlockedHere).toBeTruthy();
      expect(locked.deliveryUnlockedHere).not.toContain('{branch}');
      const branch = (messages(locale, 'branch') as { settings: { delivery: Record<string, string> } })
        .settings.delivery;
      expect(branch.descriptionUnlocked).toContain('{branch}');
    });
  }

  it('translates them rather than copying the English', () => {
    const en = (messages('en', 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
    for (const locale of ['es', 'th', 'vi']) {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
      expect(locked.deliveryUnlockedAtThisBranch).not.toBe(en.deliveryUnlockedAtThisBranch);
      expect(locked.deliveryUnlockedHere).not.toBe(en.deliveryUnlockedHere);
    }
  });
});
