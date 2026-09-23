import { describe, expect, it } from 'vitest';
import * as shared from './index';
import {
  ADDON_DELIVERY,
  DENIED_ENTITLEMENTS,
  DISCOUNT_REASONS,
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
 * The owner's own arithmetic, from docs/PACKAGING-2026-09-23.md:
 *
 *   1 branch, no delivery                        $29 / month
 *   2 branches, delivery on one         29 + 58 = $87 / month
 *   2 branches, delivery on both        58 + 58 = $116 / month
 *
 *   one-time: $228 for the first branch, $99 for each branch after it,
 *             $59 to unlock delivery on a branch — each paid once, ever.
 *
 * These mirror private.billing_apply_selection and private.billing_price_one_time.
 * A change to either side that is not made to the other should fail here.
 */

const BRANCH_A = '11111111-1111-1111-1111-111111111111';
const BRANCH_B = '22222222-2222-2222-2222-222222222222';
const BRANCH_C = '33333333-3333-3333-3333-333333333333';

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

// The live catalog after the 2026-09-23 migration.
const CATALOG: BillingProduct[] = [
  product({
    code: PLAN_TRIAL,
    name: 'Pro Start-up',
    kind: 'plan',
    monthly_price: 0,
    one_time_price: 0,
    included_seats: 1,
    trial_days: 14,
    features: { card_payment: true, delivery: true },
  }),
  product({
    code: PLAN_BASE,
    name: 'Base',
    kind: 'plan',
    monthly_price: 29,
    one_time_price: 228,
    included_seats: 1,
    features: { card_payment: true },
  }),
  product({
    code: PRODUCT_EXTRA_BRANCH,
    name: 'Extra branch',
    monthly_price: 29,
    one_time_price: 99,
    seats_per_unit: 1,
    is_quantity: true,
  }),
  product({
    code: ADDON_DELIVERY,
    name: 'Delivery',
    monthly_price: 29,
    one_time_price: 59,
    is_quantity: true,
    features: { delivery: true },
  }),
];

function sel(over: Partial<PackageSelection> = {}): PackageSelection {
  return { planCode: PLAN_BASE, branchSeats: 1, deliveryBranchIds: [], ...over };
}

function paid(over: Partial<BillingPaidState> = {}): BillingPaidState {
  return { ...NOTHING_PAID, deliveryUnlockedBranchIds: [], ...over };
}

describe('monthly — every branch is $29, and a branch with delivery is $58', () => {
  it('1 branch, no delivery: $29', () => {
    expect(packageMonthlyTotal(sel(), CATALOG)).toBe(29);
  });

  it('2 branches, delivery on one: $87', () => {
    expect(
      packageMonthlyTotal(sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }), CATALOG),
    ).toBe(87);
  });

  it('2 branches, delivery on both: $116', () => {
    expect(
      packageMonthlyTotal(sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }), CATALOG),
    ).toBe(116);
  });

  it('3 branches, delivery on two: $145', () => {
    expect(
      packageMonthlyTotal(sel({ branchSeats: 3, deliveryBranchIds: [BRANCH_A, BRANCH_B] }), CATALOG),
    ).toBe(145);
  });

  it('expands into the line items the database stores: the delivery QUANTITY is the branch count', () => {
    const lines = monthlyLines(sel({ branchSeats: 3, deliveryBranchIds: [BRANCH_A, BRANCH_B] }), CATALOG);
    expect(lines.map((l) => [l.code, l.qty, l.total])).toEqual([
      [PLAN_BASE, 1, 29],
      [PRODUCT_EXTRA_BRANCH, 2, 58],
      [ADDON_DELIVERY, 2, 58],
    ]);
  });

  it('never charges an extra branch twice — the seat line is the ONLY place a seat is priced', () => {
    // The old model put extra_branch in entitlements.addons and then priced it again
    // as an add-on: Coastal Grill's page read $545 against a stored $446.
    const lines = monthlyLines(sel({ branchSeats: 2 }), CATALOG);
    expect(lines.filter((l) => l.code === PRODUCT_EXTRA_BRANCH)).toHaveLength(1);
    expect(packageMonthlyTotal(sel({ branchSeats: 2 }), CATALOG)).toBe(58);
  });

  it('a branch costs $29, or $58 when it delivers', () => {
    const s = sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
    expect(branchMonthly(s, CATALOG, BRANCH_A)).toBe(58);
    expect(branchMonthly(s, CATALOG, BRANCH_B)).toBe(29);
    expect(branchMonthly(s, CATALOG, BRANCH_A) + branchMonthly(s, CATALOG, BRANCH_B)).toBe(
      packageMonthlyTotal(s, CATALOG),
    );
  });

  it('the trial is $0 and bills nothing for delivery, however many branches deliver', () => {
    const s = sel({ planCode: PLAN_TRIAL, branchSeats: 1, deliveryBranchIds: [BRANCH_A] });
    expect(packageMonthlyTotal(s, CATALOG)).toBe(0);
    expect(branchMonthly(s, CATALOG, BRANCH_A)).toBe(0);
  });

  // The platform console can raise a trial's seats in one click (subscriptions-manager), and
  // the seat line used to be priced at the catalog's $29 whatever the plan — so a free trial
  // with two branches read "$29 every month" while branchMonthly() said each of its branches
  // cost 0. private.billing_apply_selection had the same gap and now writes 0 too, and
  // private.billing_compute bills a trial $0 whatever its lines say.
  it('a trial granted a second branch is still $0, and its lines still add up', () => {
    const s = sel({ planCode: PLAN_TRIAL, branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
    expect(packageMonthlyTotal(s, CATALOG)).toBe(0);
    expect(monthlyLines(s, CATALOG).map((l) => [l.code, l.unit, l.total])).toEqual([
      [PLAN_TRIAL, 0, 0],
      [PRODUCT_EXTRA_BRANCH, 0, 0],
    ]);
    expect(branchMonthly(s, CATALOG, BRANCH_A) + branchMonthly(s, CATALOG, BRANCH_B)).toBe(
      packageMonthlyTotal(s, CATALOG),
    );
  });

  it('a repeated branch id is billed once', () => {
    expect(
      packageMonthlyTotal(sel({ branchSeats: 1, deliveryBranchIds: [BRANCH_A, BRANCH_A] }), CATALOG),
    ).toBe(58);
  });

  it('an empty catalog prices nothing rather than guessing', () => {
    expect(packageMonthlyTotal(sel({ branchSeats: 3 }), [])).toBe(0);
  });
});

describe('one-time — 228 + 99 + 59, and nothing charged twice', () => {
  it('a first branch is 228, not 228 + 99: the base includes it', () => {
    expect(packageOneTimeTotal(sel(), CATALOG, paid())).toBe(228);
  });

  it('two branches with delivery on one: 228 + 99 + 59 = 386', () => {
    const lines = oneTimeLines(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }),
      CATALOG,
      paid(),
    );
    expect(lines.map((l) => [l.code, l.qty, l.total])).toEqual([
      [PLAN_BASE, 1, 228],
      [PRODUCT_EXTRA_BRANCH, 1, 99],
      [ADDON_DELIVERY, 1, 59],
    ]);
    expect(packageOneTimeTotal(sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }), CATALOG, paid()))
      .toBe(386);
  });

  it('two branches with delivery on both: 228 + 99 + 59 + 59 = 445', () => {
    expect(
      packageOneTimeTotal(
        sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
        CATALOG,
        paid(),
      ),
    ).toBe(445);
  });

  it('a delivery line names its branch, so the ledger can say which one was unlocked', () => {
    const lines = oneTimeLines(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
      CATALOG,
      paid(),
    );
    expect(lines.filter((l) => l.code === ADDON_DELIVERY).map((l) => l.branchId)).toEqual([
      BRANCH_A,
      BRANCH_B,
    ]);
  });

  it('nothing already bought is charged again', () => {
    // Coastal Grill: base paid, 2 seats paid, both branches unlocked. Asking for the
    // same thing costs nothing.
    const already = paid({
      basePaid: true,
      seatsPaid: 2,
      deliveryUnlockedBranchIds: [BRANCH_A, BRANCH_B],
    });
    expect(
      packageOneTimeTotal(
        sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
        CATALOG,
        already,
      ),
    ).toBe(0);
    // A third branch is the only new money.
    expect(
      packageOneTimeTotal(
        sel({ branchSeats: 3, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
        CATALOG,
        already,
      ),
    ).toBe(99);
  });

  it("a branch's $59 is paid once ever — switching delivery off and on again is free", () => {
    const already = paid({
      basePaid: true,
      seatsPaid: 2,
      deliveryUnlockedBranchIds: [BRANCH_A, BRANCH_B],
    });
    // Off: nothing to pay, and the monthly drops by 29.
    expect(packageOneTimeTotal(sel({ branchSeats: 2 }), CATALOG, already)).toBe(0);
    expect(packageMonthlyTotal(sel({ branchSeats: 2 }), CATALOG)).toBe(58);
    // Back on: still nothing one-time.
    expect(
      packageOneTimeTotal(sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B] }), CATALOG, already),
    ).toBe(0);
  });

  it('only the branch that was never unlocked is charged', () => {
    const already = paid({ basePaid: true, seatsPaid: 3, deliveryUnlockedBranchIds: [BRANCH_A] });
    const lines = oneTimeLines(
      sel({ branchSeats: 3, deliveryBranchIds: [BRANCH_A, BRANCH_B, BRANCH_C] }),
      CATALOG,
      already,
    );
    expect(lines.map((l) => l.branchId)).toEqual([BRANCH_B, BRANCH_C]);
    expect(lines.reduce((s, l) => s + l.total, 0)).toBe(118);
  });

  it('the trial raises nothing one-time: it is granted, never sold', () => {
    expect(
      packageOneTimeTotal(
        sel({ planCode: PLAN_TRIAL, branchSeats: 1, deliveryBranchIds: [BRANCH_A] }),
        CATALOG,
        paid(),
      ),
    ).toBe(0);
  });

  it('a seat granted by the platform is not re-sold', () => {
    // billing_set_package raises no charge row; billing_paid_state reports the granted
    // seats as paid, so the plan page must not ask for them.
    const granted = paid({ basePaid: true, seatsPaid: 4 });
    expect(packageOneTimeTotal(sel({ branchSeats: 4 }), CATALOG, granted)).toBe(0);
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
      monthly_total: 87,
      features: { card_payment: true, delivery },
      addons: ['delivery'],
      delivery_branch_ids: delivery ? [BRANCH_A] : [BRANCH_B],
    });

  it('deliversHere reads the branch-resolved payload', () => {
    expect(deliversHere(branchPayload(true))).toBe(true);
    expect(deliversHere(branchPayload(false))).toBe(false);
  });

  it('carries every delivering branch of the restaurant', () => {
    expect(branchPayload(true).deliveryBranchIds).toEqual([BRANCH_A]);
  });

  it('fails closed on a payload that never mentions delivery', () => {
    const e = parseEntitlements({ restaurant_id: 'r1', entitled: false });
    expect(deliversHere(e)).toBe(false);
    expect(e.deliveryBranchIds).toEqual([]);
  });

  it('a lapsed deadline switches delivery off wherever it was bought', () => {
    const lapsed = parseEntitlements({
      restaurant_id: 'r1',
      entitled: true,
      entitled_through: '2020-01-01T00:00:00Z',
      features: { delivery: true },
      delivery_branch_ids: [BRANCH_A],
    });
    expect(deliversHere(lapsed)).toBe(false);
    // ownsFeature's data is still there, so a rider can be told which branch bought it.
    expect(lapsed.deliveryBranchIds).toEqual([BRANCH_A]);
  });

  it('pre-fills the plan page from the branches that deliver today', () => {
    const s = currentSelection(branchPayload(true));
    expect(s).toEqual({ planCode: PLAN_BASE, branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
  });

  it('a trial pre-fills as Base and keeps its delivering branches', () => {
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
    expect(currentSelection(trial)).toEqual({
      planCode: PLAN_BASE,
      branchSeats: 1,
      deliveryBranchIds: [BRANCH_A],
    });
  });

  it('a selection with no delivering branch grants no delivery feature', () => {
    expect([...selectionFeatures(sel({ branchSeats: 2 }), CATALOG)]).toEqual(['card_payment']);
    expect([...selectionFeatures(sel({ deliveryBranchIds: [BRANCH_A] }), CATALOG)].sort()).toEqual([
      'card_payment',
      'delivery',
    ]);
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

describe('what is already unlocked, and what is withdrawn', () => {
  it('carries the branches whose delivery unlock is bought', () => {
    const e = parseEntitlements({
      restaurant_id: 'r1',
      entitled: true,
      entitled_through: new Date(Date.now() + 86_400_000).toISOString(),
      delivery_branch_ids: [BRANCH_A],
      delivery_unlocked_branch_ids: [BRANCH_A, BRANCH_B, 7, null],
    });
    expect(e.deliveryUnlockedBranchIds).toEqual([BRANCH_A, BRANCH_B]);
  });

  it('reads an older payload without the list as "nothing unlocked"', () => {
    expect(parseEntitlements({ restaurant_id: 'r1' }).deliveryUnlockedBranchIds).toEqual([]);
    expect(DENIED_ENTITLEMENTS.deliveryUnlockedBranchIds).toEqual([]);
  });

  it('no longer exports a product code for the withdrawn AI Suite, but still parses its key', () => {
    expect('ADDON_AI_SUITE' in shared).toBe(false);
    expect(FEATURE_KEYS).toContain('ai_suite');
  });
});
