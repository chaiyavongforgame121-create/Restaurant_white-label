import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Entitlements } from '@favornoms/shared';
import {
  deliveryGateFrom,
  deliveryOffReason,
  deliverySettingsHref,
  navEntryAllowed,
  NO_WIND_DOWN,
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

describe('deliveryOffReason — why a branch does not deliver, in the two words a screen can use', () => {
  it('has no reason at a branch that delivers, whatever else is read', () => {
    expect(deliveryOffReason(true, true, true)).toBeNull();
    expect(deliveryOffReason(true, true, null)).toBeNull();
    // The branch payload is the server's combined answer; the switch read never overrides it.
    expect(deliveryOffReason(true, true, false)).toBeNull();
  });

  it("blames the branch's own switch only when it was read as off", () => {
    expect(deliveryOffReason(false, true, false)).toBe('switchedOff');
  });

  it('blames the restaurant when the switch is on and the branch still does not deliver', () => {
    // The platform switched delivery off (feature_overrides): nothing in branch settings helps.
    expect(deliveryOffReason(false, true, true)).toBe('notAvailable');
  });

  it('blames the restaurant once it has lapsed, even with the switch off', () => {
    // Turning the switch on would not bring delivery back; the plan page, not this screen,
    // is where a lapse is fixed.
    expect(deliveryOffReason(false, false, false)).toBe('notAvailable');
    expect(deliveryOffReason(false, false, true)).toBe('notAvailable');
  });

  it('claims nothing about the switch when it could not be read', () => {
    expect(deliveryOffReason(false, true, null)).toBe('notAvailable');
  });
});

describe('deliveryGateFrom — the gate every delivery screen reads', () => {
  it('links to the switch only when the switch is the reason', () => {
    expect(deliveryGateFrom('b1', false, true, false)).toEqual({
      delivers: false,
      reason: 'switchedOff',
      settingsHref: '/b/b1/branch#delivery-switch',
    });
    expect(deliveryGateFrom('b1', false, true, true)).toEqual({
      delivers: false,
      reason: 'notAvailable',
      settingsHref: null,
    });
    expect(deliveryGateFrom('b1', true, true, true)).toEqual({
      delivers: true,
      reason: null,
      settingsHref: null,
    });
  });

  it('never points at the plan page or carries a price', () => {
    for (const gate of [
      deliveryGateFrom('b1', false, true, false),
      deliveryGateFrom('b1', false, false, true),
      deliveryGateFrom('b1', true, true, true),
    ]) {
      expect(Object.keys(gate).sort()).toEqual(['delivers', 'reason', 'settingsHref']);
      expect(gate.settingsHref ?? '').not.toContain('/settings/plan');
    }
  });

  it('goes to branch settings, at the switch card', () => {
    expect(deliverySettingsHref('3f2a')).toBe('/b/3f2a/branch#delivery-switch');
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
  type Tree = { [k: string]: string | Tree };
  // A price, a price placeholder, or one of the old package numbers.
  const PRICE = /\$|\{(price|once|monthly)\}|\b(29|30|49|59)\b/;

  for (const locale of LOCALES) {
    it(`${locale}: says which reason, names the branch where it can, and never sells anything`, () => {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
      expect(locked.deliverySwitchedOffAtBranch).toContain('{branch}');
      expect(locked.deliveryNotAvailableAtBranch).toContain('{branch}');
      for (const key of [
        'deliverySwitchedOffHere',
        'deliveryNotAvailableHere',
        'deliveryAskToSwitchOn',
        'deliveryOpenSettings',
        'deliveryStoppedNotAvailable',
        'deliveryTurnBackOn',
      ]) {
        expect(locked[key], `${locale}: misc.lockedFeature.${key}`).toBeTruthy();
        expect(locked[key]).not.toContain('{branch}');
      }
      // "Contact FavorNoms" is the only way forward when the restaurant has no delivery.
      expect(locked.deliveryNotAvailableAtBranch).toContain('FavorNoms');
      for (const value of Object.values(locked)) expect(value).not.toMatch(PRICE);
    });

    it(`${locale}: has none of the add-on copy left`, () => {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
      for (const key of [
        'deliveryNotAtThisBranch',
        'deliveryNotHere',
        'deliveryUnlockedAtThisBranch',
        'deliveryUnlockedHere',
      ]) {
        expect(locked[key], `${locale}: misc.lockedFeature.${key}`).toBeUndefined();
      }
      // The upsell card's prices and the "part of the {addon} add-on" lock went with the paywall.
      const shell = messages(locale, 'shell') as Tree;
      expect(shell.addon).toBeUndefined();
      expect(shell.lockedFeature).toBeUndefined();
      const branch = messages(locale, 'branch') as {
        errors: Record<string, string>;
        settings: { delivery: Record<string, string> };
      };
      expect(branch.errors.stripeDeliveryActive).toBeUndefined();
      expect(branch.settings.delivery.descriptionUnlocked).toBeUndefined();
    });

    it(`${locale}: the branch switch says what on and off do, without a price`, () => {
      const d = (messages(locale, 'branch') as { settings: { delivery: Record<string, string> } }).settings
        .delivery;
      for (const key of ['title', 'on', 'off', 'saving', 'included', 'unreadable']) expect(d[key], key).toBeTruthy();
      expect(d.onBody).toContain('{branch}');
      expect(d.offBody).toContain('{branch}');
      expect(d.notAvailable).toContain('{branch}');
      for (const value of Object.values(d)) expect(value).not.toMatch(PRICE);
    });
  }

  it('translates them rather than copying the English', () => {
    const en = (messages('en', 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
    const enSwitch = (messages('en', 'branch') as { settings: { delivery: Record<string, string> } }).settings
      .delivery;
    for (const locale of ['es', 'th', 'vi']) {
      const locked = (messages(locale, 'misc') as { lockedFeature: Record<string, string> }).lockedFeature;
      for (const key of Object.keys(en)) expect(locked[key], `${locale}: ${key}`).not.toBe(en[key]);
      const sw = (messages(locale, 'branch') as { settings: { delivery: Record<string, string> } }).settings
        .delivery;
      for (const key of ['title', 'onBody', 'offBody', 'included', 'notAvailable']) {
        expect(sw[key], `${locale}: settings.delivery.${key}`).not.toBe(enSwitch[key]);
      }
    }
  });
});
