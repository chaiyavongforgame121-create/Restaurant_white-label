import { describe, expect, it } from 'vitest';
import * as shared from './index';
import {
  ADDON_DELIVERY,
  DENIED_ENTITLEMENTS,
  DISCOUNT_REASONS,
  FEATURE_DELIVERY,
  FEATURE_KEYS,
  NOTHING_PAID,
  PLAN_BASE,
  PLAN_TRIAL,
  PRODUCT_EXTRA_BRANCH,
  branchMonthly,
  currentSelection,
  deliversHere,
  describeBillingError,
  discountReasonMessage,
  monthlyLines,
  oneTimeLines,
  packageMonthlyTotal,
  packageOneTimeTotal,
  parseEntitlements,
  selectionFeatures,
  type BillingPaidState,
  type BillingProduct,
  type PackageSelection,
} from './index';

/**
 * The owner's own arithmetic, from docs/PACKAGING-2026-10-24.md:
 *
 *   1 branch      $199 once, then  $49 / month
 *   2 branches    $288 once, then  $98 / month
 *   3 branches    $377 once, then $147 / month
 *
 *   $49 a month per branch; $199 once for the first branch, $89 once for each branch
 *   after it — each paid once, ever. Every feature is included: delivery is no add-on.
 *
 * These mirror private.billing_apply_selection and private.billing_price_one_time.
 * A change to either side that is not made to the other should fail here.
 */

const BRANCH_A = '11111111-1111-1111-1111-111111111111';
const BRANCH_B = '22222222-2222-2222-2222-222222222222';

function product(over: Partial<BillingProduct> & { code: string }): BillingProduct {
  return {
    name: over.code,
    kind: 'addon',
    monthly_price: 0,
    one_time_price: 0,
    included_seats: 0,
    seats_per_unit: 0,
    trial_days: 0,
    is_quantity: false,
    features: {},
    stripe_price_id: null,
    is_active: true,
    sort_order: 0,
    description: null,
    ...over,
  };
}

// The catalog of docs/PACKAGING-2026-10-24.md §4.1. The withdrawn delivery row is kept
// (history refers to it) but inactive; listBillingProducts would leave it out, and the
// pricing must not need it to be left out.
const CATALOG: BillingProduct[] = [
  product({
    code: PLAN_TRIAL,
    name: 'Free trial',
    kind: 'plan',
    monthly_price: 0,
    one_time_price: 0,
    included_seats: 1,
    trial_days: 14,
    features: { card_payment: true, delivery: true },
  }),
  product({
    code: PLAN_BASE,
    name: 'FavorNoms Plan',
    kind: 'plan',
    monthly_price: 49,
    one_time_price: 199,
    included_seats: 1,
    features: { card_payment: true, delivery: true },
  }),
  product({
    code: PRODUCT_EXTRA_BRANCH,
    name: 'Additional branch',
    monthly_price: 49,
    one_time_price: 89,
    seats_per_unit: 1,
    is_quantity: true,
  }),
  product({
    code: FEATURE_DELIVERY,
    name: 'Delivery (withdrawn)',
    is_active: false,
  }),
];

// The same catalog with the old delivery add-on still active and priced ($30 a month, $59
// once, delivery in its features): what a catalog read before the migration, or a row
// switched back on by mistake, would hand the pricing. It must change nothing.
const CATALOG_WITH_OLD_DELIVERY: BillingProduct[] = CATALOG.map((p) =>
  p.code === FEATURE_DELIVERY
    ? { ...p, is_active: true, monthly_price: 30, one_time_price: 59, is_quantity: true, features: { delivery: true } }
    : p,
);

function sel(over: Partial<PackageSelection> = {}): PackageSelection {
  return { planCode: PLAN_BASE, branchSeats: 1, ...over };
}

function paid(over: Partial<BillingPaidState> = {}): BillingPaidState {
  return { ...NOTHING_PAID, ...over };
}

const price = (code: string) => CATALOG.find((p) => p.code === code)!;

describe('monthly — $49 for every branch', () => {
  it('is $49 × branches: 49, 98, 147, …', () => {
    for (let n = 1; n <= 10; n++) {
      expect(packageMonthlyTotal(sel({ branchSeats: n }), CATALOG), `${n} branches`).toBe(49 * n);
    }
  });

  it('expands into the line items the database stores: one plan line and one seat line', () => {
    expect(monthlyLines(sel({ branchSeats: 3 }), CATALOG).map((l) => [l.code, l.qty, l.unit, l.total])).toEqual([
      [PLAN_BASE, 1, 49, 49],
      [PRODUCT_EXTRA_BRANCH, 2, 49, 98],
    ]);
    expect(monthlyLines(sel(), CATALOG).map((l) => l.code)).toEqual([PLAN_BASE]);
  });

  it('never charges an extra branch twice — the seat line is the ONLY place a seat is priced', () => {
    const lines = monthlyLines(sel({ branchSeats: 2 }), CATALOG);
    expect(lines.filter((l) => l.code === PRODUCT_EXTRA_BRANCH)).toHaveLength(1);
    expect(packageMonthlyTotal(sel({ branchSeats: 2 }), CATALOG)).toBe(98);
  });

  it('prices the first branch and an additional one the same, so "per branch" holds', () => {
    expect(price(PLAN_BASE).monthly_price).toBe(price(PRODUCT_EXTRA_BRANCH).monthly_price);
  });

  it('a branch costs $49, and the per-branch figures add up to the total', () => {
    for (let n = 1; n <= 5; n++) {
      const s = sel({ branchSeats: n });
      expect(branchMonthly(s, CATALOG)).toBe(49);
      expect(branchMonthly(s, CATALOG) * n).toBe(packageMonthlyTotal(s, CATALOG));
    }
  });

  it('never raises a delivery line, even when the catalog still sells the old add-on', () => {
    for (const catalog of [CATALOG, CATALOG_WITH_OLD_DELIVERY]) {
      for (let n = 1; n <= 3; n++) {
        const lines = monthlyLines(sel({ branchSeats: n }), catalog);
        expect(lines.map((l) => l.code)).not.toContain(FEATURE_DELIVERY);
        expect(packageMonthlyTotal(sel({ branchSeats: n }), catalog)).toBe(49 * n);
        expect(branchMonthly(sel({ branchSeats: n }), catalog)).toBe(49);
      }
    }
  });

  it('the trial is $0', () => {
    const s = sel({ planCode: PLAN_TRIAL });
    expect(packageMonthlyTotal(s, CATALOG)).toBe(0);
    expect(branchMonthly(s, CATALOG)).toBe(0);
  });

  // The platform console can raise a trial's seats in one click (subscriptions-manager), and
  // the seat line used to be priced at the catalog's seat price whatever the plan — so a free
  // trial with two branches read as a monthly bill while branchMonthly() said each of its
  // branches cost 0. private.billing_apply_selection writes 0 too, and private.billing_compute
  // bills a trial $0 whatever its lines say.
  it('a trial granted a second branch is still $0, and its lines still add up', () => {
    const s = sel({ planCode: PLAN_TRIAL, branchSeats: 2 });
    expect(packageMonthlyTotal(s, CATALOG)).toBe(0);
    expect(monthlyLines(s, CATALOG).map((l) => [l.code, l.unit, l.total])).toEqual([
      [PLAN_TRIAL, 0, 0],
      [PRODUCT_EXTRA_BRANCH, 0, 0],
    ]);
    expect(branchMonthly(s, CATALOG) * 2).toBe(packageMonthlyTotal(s, CATALOG));
  });

  it('a selection naming something that is not a plan prices nothing', () => {
    // private.billing_apply_selection looks the plan up with kind = 'plan'.
    for (const planCode of [PRODUCT_EXTRA_BRANCH, FEATURE_DELIVERY, 'no_such_plan']) {
      expect(monthlyLines(sel({ planCode, branchSeats: 2 }), CATALOG_WITH_OLD_DELIVERY), planCode).toEqual([]);
      expect(branchMonthly(sel({ planCode }), CATALOG_WITH_OLD_DELIVERY), planCode).toBe(0);
      expect(oneTimeLines(sel({ planCode }), CATALOG_WITH_OLD_DELIVERY, paid()), planCode).toEqual([]);
    }
  });

  it('an empty catalog prices nothing rather than guessing', () => {
    expect(packageMonthlyTotal(sel({ branchSeats: 3 }), [])).toBe(0);
    expect(branchMonthly(sel(), [])).toBe(0);
  });
});

describe('one-time — $199 for the first branch, $89 for each branch after it', () => {
  it('a first branch is 199, not 199 + 89: the plan includes it', () => {
    expect(oneTimeLines(sel(), CATALOG, paid()).map((l) => [l.code, l.qty, l.total])).toEqual([
      [PLAN_BASE, 1, 199],
    ]);
    expect(packageOneTimeTotal(sel(), CATALOG, paid())).toBe(199);
  });

  it('is 199 + 89 × (branches − 1): 199, 288, 377, …', () => {
    for (let n = 1; n <= 10; n++) {
      expect(packageOneTimeTotal(sel({ branchSeats: n }), CATALOG, paid()), `${n} branches`).toBe(
        199 + 89 * (n - 1),
      );
    }
  });

  it('charges the additional branches as one line of quantity N', () => {
    expect(oneTimeLines(sel({ branchSeats: 3 }), CATALOG, paid()).map((l) => [l.code, l.qty, l.unit, l.total])).toEqual([
      [PLAN_BASE, 1, 199, 199],
      [PRODUCT_EXTRA_BRANCH, 2, 89, 178],
    ]);
  });

  it('nothing already paid is charged again', () => {
    const already = paid({ basePaid: true, seatsPaid: 2 });
    expect(packageOneTimeTotal(sel({ branchSeats: 2 }), CATALOG, already)).toBe(0);
    expect(oneTimeLines(sel({ branchSeats: 2 }), CATALOG, already)).toEqual([]);
    // A third branch is the only new money.
    expect(oneTimeLines(sel({ branchSeats: 3 }), CATALOG, already).map((l) => [l.code, l.qty, l.total])).toEqual([
      [PRODUCT_EXTRA_BRANCH, 1, 89],
    ]);
    // Dropping to fewer branches than were paid for refunds nothing and charges nothing.
    expect(packageOneTimeTotal(sel({ branchSeats: 1 }), CATALOG, already)).toBe(0);
  });

  it('once the plan is paid, the ledger decides what is covered', () => {
    expect(packageOneTimeTotal(sel({ branchSeats: 2 }), CATALOG, paid({ basePaid: true, seatsPaid: 1 }))).toBe(89);
  });

  it('a seat granted by the platform is not re-sold', () => {
    // billing_set_package raises no charge row; billing_paid_state reports the granted
    // seats as paid, so the plan page must not ask for them.
    const granted = paid({ basePaid: true, seatsPaid: 4 });
    expect(packageOneTimeTotal(sel({ branchSeats: 4 }), CATALOG, granted)).toBe(0);
  });

  it('the trial raises nothing one-time: it is granted, never sold', () => {
    expect(packageOneTimeTotal(sel({ planCode: PLAN_TRIAL, branchSeats: 2 }), CATALOG, paid())).toBe(0);
  });

  it('never raises a delivery line or a per-branch line, even when the catalog still sells the old add-on', () => {
    for (const catalog of [CATALOG, CATALOG_WITH_OLD_DELIVERY]) {
      const lines = oneTimeLines(sel({ branchSeats: 3 }), catalog, paid());
      expect(lines.map((l) => l.code)).toEqual([PLAN_BASE, PRODUCT_EXTRA_BRANCH]);
      expect(lines.every((l) => l.branchId === undefined)).toBe(true);
      expect(packageOneTimeTotal(sel({ branchSeats: 3 }), catalog, paid())).toBe(377);
    }
  });

  it('NOTHING_PAID is the plan and no seats, with no delivery state', () => {
    expect(NOTHING_PAID).toEqual({ basePaid: false, seatsPaid: 0 });
  });
});

describe('every feature included', () => {
  it('the plan grants exactly card payment and delivery, however many branches', () => {
    for (let n = 1; n <= 3; n++) {
      expect([...selectionFeatures(sel({ branchSeats: n }), CATALOG)].sort()).toEqual(['card_payment', 'delivery']);
    }
  });

  it('the same as the trial, so converting switches nothing off', () => {
    expect([...selectionFeatures(sel({ planCode: PLAN_TRIAL }), CATALOG)].sort()).toEqual([
      'card_payment',
      'delivery',
    ]);
  });

  it('the withdrawn delivery product adds nothing even if it is still in the catalog', () => {
    expect([...selectionFeatures(sel({ branchSeats: 2 }), CATALOG_WITH_OLD_DELIVERY)].sort()).toEqual([
      'card_payment',
      'delivery',
    ]);
  });

  it('keeps the old product code as a deprecated name for the delivery feature key', () => {
    expect(FEATURE_DELIVERY).toBe('delivery');
    expect(ADDON_DELIVERY).toBe(FEATURE_DELIVERY);
  });
});

describe('per-branch delivery', () => {
  const branchPayload = (delivery: boolean) =>
    parseEntitlements({
      restaurant_id: 'r1',
      branch_id: BRANCH_A,
      plan_code: 'base',
      status: 'active',
      entitled: true,
      entitled_through: new Date(Date.now() + 86_400_000).toISOString(),
      branch_seats: 2,
      branches_used: 2,
      monthly_total: 98,
      features: { card_payment: true, delivery },
      addons: [],
      delivery_branch_ids: delivery ? [BRANCH_A, BRANCH_B] : [BRANCH_B],
    });

  it('deliversHere reads the branch-resolved payload: a branch can switch delivery off', () => {
    expect(deliversHere(branchPayload(true))).toBe(true);
    expect(deliversHere(branchPayload(false))).toBe(false);
  });

  it('carries every delivering branch of the restaurant', () => {
    expect(branchPayload(true).deliveryBranchIds).toEqual([BRANCH_A, BRANCH_B]);
    expect(branchPayload(false).deliveryBranchIds).toEqual([BRANCH_B]);
  });

  it('fails closed on a payload that never mentions delivery', () => {
    const e = parseEntitlements({ restaurant_id: 'r1', entitled: false });
    expect(deliversHere(e)).toBe(false);
    expect(e.deliveryBranchIds).toEqual([]);
  });

  it('a lapsed deadline switches delivery off everywhere', () => {
    const lapsed = parseEntitlements({
      restaurant_id: 'r1',
      entitled: true,
      entitled_through: '2020-01-01T00:00:00Z',
      features: { delivery: true },
      delivery_branch_ids: [BRANCH_A],
    });
    expect(deliversHere(lapsed)).toBe(false);
    // ownsFeature's data is still there, so a rider can be told which branch it was.
    expect(lapsed.deliveryBranchIds).toEqual([BRANCH_A]);
  });
});

describe('pre-filling the plan page', () => {
  it('starts from the plan and the branches the restaurant pays for, nothing about delivery', () => {
    const e = parseEntitlements({
      restaurant_id: 'r1',
      plan_code: 'base',
      status: 'active',
      entitled: true,
      entitled_through: new Date(Date.now() + 86_400_000).toISOString(),
      branch_seats: 2,
      features: { card_payment: true, delivery: true },
      delivery_branch_ids: [BRANCH_A],
    });
    expect(currentSelection(e)).toEqual({ planCode: PLAN_BASE, branchSeats: 2 });
  });

  it('a trial pre-fills as the FavorNoms Plan, with the branches it has', () => {
    const trial = parseEntitlements({
      restaurant_id: 'r1',
      plan_code: 'trial',
      status: 'trialing',
      entitled: true,
      entitled_through: new Date(Date.now() + 86_400_000).toISOString(),
      branch_seats: 1,
      features: { card_payment: true, delivery: true },
      delivery_branch_ids: [BRANCH_A],
    });
    expect(currentSelection(trial)).toEqual({ planCode: PLAN_BASE, branchSeats: 1 });
  });

  it('no subscription at all pre-fills one branch of the plan', () => {
    expect(currentSelection(null)).toEqual({ planCode: PLAN_BASE, branchSeats: 1 });
    expect(currentSelection(DENIED_ENTITLEMENTS)).toEqual({ planCode: PLAN_BASE, branchSeats: 1 });
  });
});

describe('discount refusals read as words, not codes', () => {
  it('decodes the request-time refusal', () => {
    expect(describeBillingError(new Error('discount_invalid:code_expired'))).toEqual({
      kind: 'discount',
      reason: 'code_expired',
    });
  });

  it('decodes the guessing limit, which request_package_change answers in the same shape', () => {
    expect(describeBillingError(new Error('discount_invalid:rate_limited'))).toEqual({
      kind: 'discount',
      reason: 'rate_limited',
    });
  });

  it('says why in every interface language', () => {
    expect(discountReasonMessage('per_restaurant_limit_reached', 'en')).toBe(
      'You have already used that code.',
    );
    for (const locale of ['en', 'es', 'vi', 'th'] as const) {
      expect(discountReasonMessage('code_expired', locale).length).toBeGreaterThan(0);
    }
  });

  // Every reason the server can answer has its own sentence in all four languages -- none of
  // them falls through to the generic "could not be applied", which would tell a merchant who
  // hit the guessing limit nothing about waiting.
  it('has a sentence of its own for every reason, in every language', () => {
    for (const locale of ['en', 'es', 'vi', 'th'] as const) {
      const generic = discountReasonMessage('unknown', locale);
      const seen = new Set<string>();
      for (const reason of DISCOUNT_REASONS) {
        const text = discountReasonMessage(reason, locale);
        expect(text, `${locale}:${reason}`).not.toBe(generic);
        seen.add(text);
      }
      expect(seen.size, locale).toBe(DISCOUNT_REASONS.length);
    }
  });

  it('tells a merchant past the guessing limit to wait, in their language', () => {
    expect(discountReasonMessage('rate_limited', 'en')).toBe(
      'Too many codes tried. Wait 15 minutes, then try again.',
    );
    expect(discountReasonMessage('rate_limited', 'th')).toBe(
      'ลองรหัสหลายครั้งเกินไป โปรดรอ 15 นาทีแล้วลองอีกครั้ง',
    );
    expect(discountReasonMessage('rate_limited', 'es')).toContain('15');
    expect(discountReasonMessage('rate_limited', 'vi')).toContain('15');
  });

  // Unknown, switched-off and not-yet-started codes are one answer on the server, so the words
  // must not claim one of the three ("we do not recognise it" is false for a switched-off code).
  it('says one thing for a code that cannot be used, whatever the reason behind it', () => {
    expect(discountReasonMessage('invalid_code', 'en')).toBe(
      'That code is not valid. Check it and try again.',
    );
    expect(DISCOUNT_REASONS as readonly string[]).not.toContain('code_inactive');
    expect(DISCOUNT_REASONS as readonly string[]).not.toContain('code_not_started');
  });

  it('never leaks an unrecognised reason onto the page', () => {
    expect(discountReasonMessage('some_new_thing', 'en')).toBe('That code could not be applied.');
    expect(discountReasonMessage(null, 'en')).toBe('That code could not be applied.');
  });
});

describe('what is withdrawn', () => {
  it('no longer reads which branches had their delivery unlock bought: there is none to buy', () => {
    const e = parseEntitlements({
      restaurant_id: 'r1',
      entitled: true,
      entitled_through: new Date(Date.now() + 86_400_000).toISOString(),
      delivery_branch_ids: [BRANCH_A],
      // Still in the payload for old readers (docs §4.2).
      delivery_unlocked_branch_ids: [BRANCH_A, BRANCH_B],
    });
    expect(e.deliveryBranchIds).toEqual([BRANCH_A]);
    expect('deliveryUnlockedBranchIds' in e).toBe(false);
    expect('deliveryUnlockedBranchIds' in DENIED_ENTITLEMENTS).toBe(false);
  });

  it('no longer exports a product code for the withdrawn AI Suite, but still parses its key', () => {
    expect('ADDON_AI_SUITE' in shared).toBe(false);
    expect(FEATURE_KEYS).toContain('ai_suite');
  });
});

describe('how the restaurant pays the platform', () => {
  it('reads the card rail from billing_rail', () => {
    expect(parseEntitlements({ restaurant_id: 'r1', billing_rail: 'stripe' }).billingRail).toBe('stripe');
    expect(parseEntitlements({ restaurant_id: 'r1', billing_rail: 'manual' }).billingRail).toBe('manual');
  });

  it('reads anything else as the manual rail, the one whose deadline is warned about', () => {
    // An older payload has no key; a typo or another type must not silence the countdown.
    for (const raw of [undefined, null, '', 'STRIPE', 'card', true, 1, { rail: 'stripe' }]) {
      expect(parseEntitlements({ restaurant_id: 'r1', billing_rail: raw }).billingRail, String(raw)).toBe('manual');
    }
    expect(parseEntitlements(null).billingRail).toBe('manual');
    expect(DENIED_ENTITLEMENTS.billingRail).toBe('manual');
  });

  it('reads when a card subscription set to end ends, for every role (ui-rr-3)', () => {
    const at = '2026-10-26T12:00:00+00:00';
    expect(
      parseEntitlements({ restaurant_id: 'r1', billing_rail: 'stripe', billing_ends_at: at }).billingEndsAt,
    ).toBe(at);
  });

  it('reads no end date as a subscription that renews', () => {
    // An older payload has no key; a value that is not a readable date is no date to count down to.
    for (const raw of [undefined, null, '', 'soon', 42, true, { at: '2026-10-26' }]) {
      expect(parseEntitlements({ restaurant_id: 'r1', billing_ends_at: raw }).billingEndsAt, String(raw)).toBeNull();
    }
    expect(parseEntitlements(null).billingEndsAt).toBeNull();
    expect(DENIED_ENTITLEMENTS.billingEndsAt).toBeNull();
  });
});
