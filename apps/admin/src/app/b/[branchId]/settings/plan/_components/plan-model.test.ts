import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createTranslator } from 'next-intl';
import {
  DENIED_ENTITLEMENTS,
  NOTHING_PAID,
  type BillingPaidState,
  type BillingProduct,
  type Entitlements,
  type PackageSelection,
} from '@favornoms/shared';
import {
  MAX_SEATS,
  branchRows,
  canQuote,
  fallbackOverview,
  isDirty,
  joinNames,
  minimumSeats,
  netOneTime,
  normalizeSelection,
  openingSelection,
  planTotals,
  priceOf,
  sameSelection,
  selectionFromRequest,
  selectionKey,
  submittableCode,
  summaryFacts,
  toggleDelivery,
  withSeats,
  type PlanBranch,
} from './plan-model';

// The owner's own examples, from docs/PACKAGING-2026-09-23.md §1:
//
//   1 branch, no delivery                     $29 / month
//   2 branches, delivery on one      29 + 58 = $87 / month
//   2 branches, delivery on both     58 + 58 = $116 / month
//   first purchase (1 branch)                 $228 once
//   one more branch                            $99 once
//   delivery on a branch                       $59 once, and never again
//
// Every number below comes from this catalog, never from the code under test — a price
// hardcoded in a component is exactly what rule 1 of the packaging doc forbids.

const product = (over: Partial<BillingProduct> & { code: string }): BillingProduct => ({
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
});

const CATALOG: BillingProduct[] = [
  product({
    code: 'base',
    name: 'Base',
    kind: 'plan',
    monthly_price: 29,
    one_time_price: 228,
    included_seats: 1,
    features: { card_payment: true },
  }),
  product({
    code: 'extra_branch',
    name: 'Extra branch',
    monthly_price: 29,
    one_time_price: 99,
    seats_per_unit: 1,
    is_quantity: true,
  }),
  product({
    code: 'delivery',
    name: 'Delivery',
    monthly_price: 29,
    one_time_price: 59,
    is_quantity: true,
    features: { delivery: true },
  }),
  product({
    code: 'trial',
    name: 'Free trial',
    kind: 'plan',
    trial_days: 14,
    included_seats: 1,
    features: { card_payment: true, delivery: true },
  }),
];

const BRANCH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const BRANCH_B = 'bbbbbbbb-0000-4000-8000-000000000002';

const branch = (id: string, name: string, over: Partial<PlanBranch> = {}): PlanBranch => ({
  id,
  name,
  deliveryActive: false,
  deliveryUnlocked: false,
  ...over,
});

const TWO_BRANCHES = [branch(BRANCH_A, 'Food Thai Thai'), branch(BRANCH_B, 'Riverside')];

const sel = (over: Partial<PackageSelection> = {}): PackageSelection => ({
  planCode: 'base',
  branchSeats: 1,
  deliveryBranchIds: [],
  ...over,
});

const paidState = (over: Partial<BillingPaidState> = {}): BillingPaidState => ({
  ...NOTHING_PAID,
  ...over,
});

const ent = (over: Partial<Entitlements> = {}): Entitlements => ({
  ...DENIED_ENTITLEMENTS,
  restaurantId: 'r1',
  planCode: 'base',
  status: 'active',
  entitled: true,
  branchSeats: 1,
  branchesUsed: 1,
  ...over,
});

describe('the monthly bill', () => {
  it('is $29 for one branch with no delivery', () => {
    expect(planTotals(sel(), CATALOG, [TWO_BRANCHES[0]!], NOTHING_PAID).monthlyTotal).toBe(29);
  });

  it('is $87 for two branches with delivery at one of them', () => {
    const totals = planTotals(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }),
      CATALOG,
      TWO_BRANCHES,
      NOTHING_PAID,
    );
    expect(totals.monthlyTotal).toBe(87);
    expect(totals.perBranch.map((l) => l.monthly)).toEqual([58, 29]);
  });

  it('is $116 for two branches that both deliver', () => {
    expect(
      planTotals(
        sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
        CATALOG,
        TWO_BRANCHES,
        NOTHING_PAID,
      ).monthlyTotal,
    ).toBe(116);
  });

  // The seat floor keeps the seats at or above the branches on screen, so the itemised
  // lines are the whole bill. A page whose arithmetic does not add up is exactly the
  // confusion the owner asked us to remove.
  it('adds up: the per-branch lines plus the unused seats ARE the total', () => {
    for (const [seats, delivers, branches] of [
      [1, [], [TWO_BRANCHES[0]!]],
      [2, [BRANCH_A], TWO_BRANCHES],
      [2, [BRANCH_A, BRANCH_B], TWO_BRANCHES],
      [4, [BRANCH_B], TWO_BRANCHES],
    ] as Array<[number, string[], PlanBranch[]]>) {
      const totals = planTotals(
        sel({ branchSeats: seats, deliveryBranchIds: delivers }),
        CATALOG,
        branches,
        NOTHING_PAID,
      );
      const shown =
        totals.perBranch.reduce((sum, l) => sum + l.monthly, 0) +
        totals.unusedSeats * totals.seatMonthly;
      expect(shown).toBe(totals.monthlyTotal);
    }
  });

  it('counts a seat bought ahead of its branch', () => {
    const totals = planTotals(sel({ branchSeats: 3 }), CATALOG, TWO_BRANCHES, NOTHING_PAID);
    expect(totals.unusedSeats).toBe(1);
    expect(totals.seatMonthly).toBe(29);
    expect(totals.monthlyTotal).toBe(87);
  });
});

describe('what is paid once', () => {
  it('is $228 for a first purchase, the first branch included', () => {
    const totals = planTotals(sel(), CATALOG, [TWO_BRANCHES[0]!], NOTHING_PAID);
    expect(totals.oneTimeTotal).toBe(228);
    expect(totals.oneTimeLines.map((l) => l.code)).toEqual(['base']);
  });

  it('is $99 to add a branch once the base is paid', () => {
    const paid = paidState({ basePaid: true, seatsPaid: 1 });
    expect(planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, paid).oneTimeTotal).toBe(99);
  });

  it('is $59 to unlock delivery on a branch', () => {
    const paid = paidState({ basePaid: true, seatsPaid: 2 });
    const totals = planTotals(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B] }),
      CATALOG,
      TWO_BRANCHES,
      paid,
    );
    expect(totals.oneTimeTotal).toBe(59);
    expect(totals.oneTimeLines[0]!.branchId).toBe(BRANCH_B);
  });

  it('charges nothing twice: a branch unlocked before is free to switch back on', () => {
    const paid = paidState({
      basePaid: true,
      seatsPaid: 2,
      deliveryUnlockedBranchIds: [BRANCH_A],
    });
    const totals = planTotals(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }),
      CATALOG,
      TWO_BRANCHES,
      paid,
    );
    expect(totals.oneTimeTotal).toBe(0);
    expect(totals.oneTimeLines).toEqual([]);
  });

  it('asks for both fees at once when a new branch also delivers', () => {
    const paid = paidState({ basePaid: true, seatsPaid: 1 });
    const totals = planTotals(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B] }),
      CATALOG,
      TWO_BRANCHES,
      paid,
    );
    expect(totals.oneTimeTotal).toBe(99 + 59);
  });

  it('never mixes the two totals', () => {
    const totals = planTotals(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }),
      CATALOG,
      TWO_BRANCHES,
      NOTHING_PAID,
    );
    expect(totals.oneTimeTotal).toBe(228 + 99 + 59);
    expect(totals.monthlyTotal).toBe(87);
  });
});

describe('the branch rows', () => {
  it('quotes the unlock only for a branch that never had delivery', () => {
    const rows = branchRows(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] }),
      CATALOG,
      [branch(BRANCH_A, 'Food Thai Thai', { deliveryActive: true, deliveryUnlocked: true }), TWO_BRANCHES[1]!],
      NOTHING_PAID,
    );
    expect(rows[0]!.deliveryOnce).toBe(0);
    expect(rows[0]!.monthly).toBe(58);
    expect(rows[1]!.deliveryOnce).toBe(59);
    expect(rows[1]!.monthly).toBe(29);
  });

  // A trial delivers everywhere and has bought nothing: get_billing_overview reports
  // delivery_active true (private.branch_owns_feature short-circuits on trial_days) and
  // delivery_unlocked false, and billing_paid_state holds no branch at all. The row used to
  // read "delivers today, so it must have been paid for" and hid the unlock, while the server
  // — private.billing_price_one_time, mirrored by oneTimeLines — charged it anyway. The two
  // halves of this test are the two halves of the same screen and must agree.
  it('still quotes the unlock on a trial, where delivery is granted and nothing was bought', () => {
    const trialBranches = [
      branch(BRANCH_A, 'Food Thai Thai', { deliveryActive: true, deliveryUnlocked: false }),
    ];
    const selection = sel({ branchSeats: 1, deliveryBranchIds: [BRANCH_A] });
    const rows = branchRows(selection, CATALOG, trialBranches, NOTHING_PAID);
    expect(rows[0]!.unlocked).toBe(false);
    expect(rows[0]!.deliveryOnce).toBe(59);

    const totals = planTotals(selection, CATALOG, trialBranches, NOTHING_PAID);
    expect(totals.oneTimeTotal).toBe(228 + 59);
    expect(totals.oneTimeLines.some((l) => l.branchId === BRANCH_A && l.total === 59)).toBe(true);
  });

  // The same trial case on the page's other road in: when get_billing_overview cannot be read
  // the page rebuilds the branches from the entitlements, and it used to mark every branch that
  // delivers today as unlocked — i.e. every branch of every trial.
  it('still quotes the unlock on a trial when the overview could not be read', () => {
    const trialing = ent({ planCode: 'trial', status: 'trialing', deliveryBranchIds: [BRANCH_A] });
    const { branches, paid } = fallbackOverview(trialing, [{ id: BRANCH_A, name: 'Food Thai Thai' }]);
    expect(branches[0]).toMatchObject({ deliveryActive: true, deliveryUnlocked: false });
    const rows = branchRows(sel({ deliveryBranchIds: [BRANCH_A] }), CATALOG, branches, paid);
    expect(rows[0]!.deliveryOnce).toBe(59);
  });

  it('never re-sells the unlock to a paying branch when the overview could not be read', () => {
    const paying = ent({ branchSeats: 2, branchesUsed: 2, deliveryBranchIds: [BRANCH_A] });
    const { branches, paid } = fallbackOverview(paying, [
      { id: BRANCH_A, name: 'Food Thai Thai' },
      { id: BRANCH_B, name: 'Riverside' },
    ]);
    const selection = sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
    expect(branchRows(selection, CATALOG, branches, paid).map((r) => r.deliveryOnce)).toEqual([0, 59]);
    expect(planTotals(selection, CATALOG, branches, paid).oneTimeTotal).toBe(0);
  });

  it('warns when a branch that delivers today is switched off, and says what it drops to', () => {
    const branches = [branch(BRANCH_A, 'Food Thai Thai', { deliveryActive: true, deliveryUnlocked: true })];
    const rows = branchRows(sel(), CATALOG, branches, NOTHING_PAID);
    expect(rows[0]!.losingDelivery).toBe(true);
    expect(rows[0]!.monthlyWithoutDelivery).toBe(29);
  });

  it('does not warn about a branch that never delivered', () => {
    expect(branchRows(sel(), CATALOG, TWO_BRANCHES, NOTHING_PAID)[0]!.losingDelivery).toBe(false);
  });
});

describe('the selection', () => {
  it('never drops below the branches already open', () => {
    const minSeats = minimumSeats(ent({ branchesUsed: 2, branchSeats: 2 }), TWO_BRANCHES);
    expect(minSeats).toBe(2);
    expect(withSeats(sel({ branchSeats: 2 }), 1, minSeats).branchSeats).toBe(2);
    expect(withSeats(sel({ branchSeats: 2 }), 5, minSeats).branchSeats).toBe(5);
    expect(withSeats(sel(), 500, minSeats).branchSeats).toBe(MAX_SEATS);
  });

  it('keeps a restaurant with more branches than the stepper offers at its own branch count', () => {
    // The cap is a stepper limit, not a floor-breaker: a request below the branches in use is
    // refused by the server (plan_limit_exceeded), so the page must never produce one.
    expect(withSeats(sel(), MAX_SEATS + 20, MAX_SEATS + 5).branchSeats).toBe(MAX_SEATS + 5);
  });

  it('drops delivery ids that are not this restaurant’s branches', () => {
    const cleaned = normalizeSelection(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, 'not-ours'] }),
      TWO_BRANCHES,
      2,
    );
    expect(cleaned.deliveryBranchIds).toEqual([BRANCH_A]);
  });

  it('opens with the branch the upsell link named', () => {
    const opening = openingSelection({
      entitlements: ent({ branchSeats: 2, branchesUsed: 2 }),
      branches: TWO_BRANCHES,
      minSeats: 2,
      addDelivery: true,
      branchParam: BRANCH_B,
    });
    expect(opening.selection.deliveryBranchIds).toEqual([BRANCH_B]);
    expect(opening.focusBranchId).toBe(BRANCH_B);
  });

  it('switches the only branch on when ?add=delivery arrives without one', () => {
    const opening = openingSelection({
      entitlements: ent(),
      branches: [TWO_BRANCHES[0]!],
      minSeats: 1,
      addDelivery: true,
      branchParam: null,
    });
    expect(opening.selection.deliveryBranchIds).toEqual([BRANCH_A]);
  });

  it('guesses nothing when several branches could be meant', () => {
    const opening = openingSelection({
      entitlements: ent({ branchSeats: 2, branchesUsed: 2 }),
      branches: TWO_BRANCHES,
      minSeats: 2,
      addDelivery: true,
      branchParam: null,
    });
    expect(opening.selection.deliveryBranchIds).toEqual([]);
    expect(opening.focusBranchId).toBeNull();
  });

  it('carries over the branches that deliver today', () => {
    const opening = openingSelection({
      entitlements: ent({ branchSeats: 2, branchesUsed: 2, deliveryBranchIds: [BRANCH_A] }),
      branches: TWO_BRANCHES,
      minSeats: 2,
      addDelivery: false,
      branchParam: null,
    });
    expect(opening.selection).toEqual({
      planCode: 'base',
      branchSeats: 2,
      deliveryBranchIds: [BRANCH_A],
    });
  });

  it('treats a trialing restaurant as a change, so it can be confirmed', () => {
    const trialing = ent({ planCode: 'trial', status: 'trialing', deliveryBranchIds: [BRANCH_A] });
    expect(isDirty(sel({ deliveryBranchIds: [BRANCH_A] }), trialing)).toBe(true);
  });

  it('treats an unchanged package as clean whatever the order of the ids', () => {
    const current = ent({
      branchSeats: 2,
      branchesUsed: 2,
      deliveryBranchIds: [BRANCH_A, BRANCH_B],
    });
    expect(isDirty(sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B, BRANCH_A] }), current)).toBe(
      false,
    );
  });

  it('compares two selections by what they buy, not by list order', () => {
    expect(
      sameSelection(
        sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
        sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B, BRANCH_A] }),
      ),
    ).toBe(true);
    expect(toggleDelivery(sel(), BRANCH_A, true).deliveryBranchIds).toEqual([BRANCH_A]);
    expect(toggleDelivery(sel({ deliveryBranchIds: [BRANCH_A] }), BRANCH_A, false).deliveryBranchIds)
      .toEqual([]);
  });

  it('reads a queued request back as a selection', () => {
    expect(
      selectionFromRequest({
        plan_code: 'base',
        branch_seats: 2,
        delivery_branch_ids: [BRANCH_A],
      }),
    ).toEqual({ planCode: 'base', branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
  });
});

describe('the discount code', () => {
  const selection = sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_A] });
  const applied = {
    code: 'LAUNCH50',
    label: 'Launch offer',
    amountOff: 50,
    netTotal: 336,
    key: selectionKey(selection),
  };

  it('shows the server’s number, not one of its own', () => {
    expect(netOneTime(selection, 386, applied)).toBe(336);
    expect(submittableCode(selection, applied)).toBe('LAUNCH50');
  });

  it('re-prices at list price when the package changes under it', () => {
    const changed = toggleDelivery(selection, BRANCH_B, true);
    expect(netOneTime(changed, 445, applied)).toBe(445);
    expect(submittableCode(changed, applied)).toBeNull();
  });

  it('re-prices at list price when the code is cleared', () => {
    expect(netOneTime(selection, 386, null)).toBe(386);
    expect(submittableCode(selection, null)).toBeNull();
  });
});

describe('the plain-language summary', () => {
  it('names the branches that deliver, in the order the page lists them', () => {
    const facts = summaryFacts(
      sel({ branchSeats: 2, deliveryBranchIds: [BRANCH_B, BRANCH_A] }),
      CATALOG,
      TWO_BRANCHES,
      NOTHING_PAID,
    );
    expect(facts.branches).toBe(2);
    expect(facts.deliveryNames).toEqual(['Food Thai Thai', 'Riverside']);
    expect(facts.monthlyTotal).toBe(116);
  });

  it('joins names the way the reader’s language does', () => {
    expect(joinNames(['Food Thai Thai'], 'en-US')).toBe('Food Thai Thai');
    expect(joinNames(['Food Thai Thai', 'Riverside'], 'en-US')).toContain('and');
    expect(joinNames([], 'en-US')).toBe('');
  });
});

describe('the catalog is the only price list', () => {
  it('reads both prices of a product', () => {
    expect(priceOf(CATALOG, 'delivery')).toEqual({ monthly: 29, once: 59 });
  });

  it('prices nothing at all when the catalog could not be read', () => {
    const totals = planTotals(sel({ branchSeats: 2 }), [], TWO_BRANCHES, NOTHING_PAID);
    expect(totals.monthlyTotal).toBe(0);
    expect(totals.oneTimeTotal).toBe(0);
    expect(priceOf([], 'delivery')).toEqual({ monthly: 0, once: 0 });
  });

  // Those zeros are what a failed read produces (listBillingProducts answers an error with
  // []), and the page used to print them as a quote — "$0/mo", "$0 every month", "Nothing.
  // Everything … is already paid for." — with Confirm enabled. Coastal Grill's real package
  // (two branches, delivery at both) is $116 a month; it must never read as free.
  it('refuses to quote from a catalog that could not be read', () => {
    expect(canQuote([], 'base')).toBe(false);
    expect(canQuote(CATALOG, 'base')).toBe(true);
  });

  it('refuses to quote when any product the page prices is missing', () => {
    const without = (code: string) => CATALOG.filter((p) => p.code !== code);
    expect(canQuote(without('base'), 'base')).toBe(false);
    expect(canQuote(without('extra_branch'), 'base')).toBe(false);
    expect(canQuote(without('delivery'), 'base')).toBe(false);
    // An add-on that happens to share the plan's code is not the plan.
    expect(canQuote([...without('base'), product({ code: 'base' })], 'base')).toBe(false);
  });
});

// --- every string the page renders exists in every language ------------------

type Tree = { [key: string]: string | Tree };
const LOCALES = ['en', 'es', 'th', 'vi'] as const;

const catalogue = (locale: string): Tree =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../../../../messages', locale, 'settings.json'),
      'utf8',
    ),
  ) as Tree;

/** Every key plan-view.tsx asks for, with the arguments it passes. */
const USED: Array<[string, Record<string, string | number>?]> = [
  ['metaTitle'],
  ['title'],
  ['subtitle'],
  ['perMonth'],
  ['notYours.inactiveTitle'],
  ['notYours.lockedTitle'],
  ['notYours.inactiveBody', { branch: 'Food Thai Thai' }],
  ['notYours.lockedBody', { branch: 'Food Thai Thai' }],
  ['replaceDialog.title'],
  ['replaceDialog.body', { summary: '2 branches' }],
  ['replaceDialog.codeReleased', { code: 'WELCOME50' }],
  ['replaceDialog.confirm'],
  ['errors.sendFailed'],
  ['errors.generic'],
  ['errors.signedOut'],
  ['errors.forbidden'],
  ['errors.planUnavailable'],
  ['action.pending'],
  ['action.replace'],
  ['action.requestActivation'],
  ['action.reactivate'],
  ['action.confirm'],
  ['action.renew'],
  ['action.current'],
  ['action.pricesUnavailable'],
  ['now.title'],
  ['now.plan'],
  ['now.trialPlan'],
  ['now.noPlan'],
  ['now.branches'],
  ['now.branchesValue', { used: 1, seats: 2 }],
  ['now.delivery'],
  ['now.deliveryNone'],
  ['now.deliveryTrial'],
  ['now.nextPayment'],
  ['now.trialEnds'],
  ['now.noNextPayment'],
  ['now.includedTitle'],
  ['base.name'],
  ['base.included.cardPayment'],
  ['base.included.onlineOrdering'],
  ['base.included.reportsLoyalty'],
  ['base.included.kitchenCounter'],
  ['base.included.oneBranch'],
  ['branches.title'],
  ['branches.subtitle', { price: '$29' }],
  ['branches.subtitleNoPrice'],
  ['branches.empty'],
  ['branches.delivery'],
  ['branches.switchLabel', { branch: 'Food Thai Thai' }],
  ['branches.eachMonth', { price: '$58' }],
  ['branches.costOnceAndMonthly', { once: '$59', monthly: '$29' }],
  ['branches.costMonthly', { monthly: '$29' }],
  ['branches.alreadyUnlocked'],
  ['branches.offWarning', { branch: 'Food Thai Thai' }],
  ['branches.dropsTo', { price: '$29' }],
  ['branches.trialNote'],
  ['seats.title'],
  ['seats.body', { once: '$99', monthly: '$29' }],
  ['seats.usage', { used: 1, seats: 2 }],
  ['seats.remove'],
  ['seats.add'],
  ['seats.floor', { count: 2, min: 2 }],
  ['seats.newSeats', { count: 1 }],
  ['seats.newSeatsReady', { count: 1 }],
  ['pay.title'],
  ['pay.onceTitle'],
  ['pay.onceNothing'],
  ['pay.onceOnRequest'],
  ['pay.onceCode', { code: 'WELCOME50' }],
  ['pay.onceAwaiting'],
  ['pay.monthlyTitle'],
  ['pay.withDelivery', { branch: 'Food Thai Thai' }],
  ['pay.unusedSeats', { count: 1 }],
  ['pay.forBranch', { product: 'Delivery', branch: 'Food Thai Thai' }],
  ['pay.total'],
  ['pay.summary.branches', { count: 2 }],
  ['pay.summary.delivery', { names: 'Food Thai Thai' }],
  ['pay.summary.noDelivery'],
  ['pay.summary.line', { branches: '2 branches', delivery: 'no delivery', price: '$87' }],
  ['pay.summary.plusOnce', { price: '$228' }],
  ['pay.trialNote'],
  ['pay.footnote'],
  ['discount.title'],
  ['discount.placeholder'],
  ['discount.apply'],
  ['discount.remove'],
  ['discount.applied', { label: 'Launch offer', amount: '$50' }],
  ['discount.appliedPlain', { amount: '$50' }],
  ['discount.repriced'],
  ['discount.notApplied'],
  ['discount.onlyOnce'],
  ['trial.active'],
  ['trial.endsToday'],
  ['trial.daysLeft', { days: 3 }],
  ['trial.body'],
  ['suspended.title'],
  ['suspended.body'],
  ['noTrial.title'],
  ['noTrial.body'],
  ['renew.title'],
  ['renew.paidThrough', { date: 'Oct 1, 2026' }],
  ['renew.body'],
  ['pricesUnavailable.title'],
  ['pricesUnavailable.body'],
  ['pricesUnavailable.pay'],
  ['decision.approvedOn', { date: 'Oct 1, 2026' }],
  ['decision.declinedOn', { date: 'Oct 1, 2026' }],
  ['decision.noteLabel'],
  ['decision.noReason'],
  ['decision.approved'],
  ['decision.declined'],
  ['pending.title'],
  ['pending.titleSent', { date: 'Oct 1, 2026' }],
  ['pending.body'],
  ['pending.badge'],
];

describe('the plan page speaks every language', () => {
  for (const locale of LOCALES) {
    it(`renders every key in ${locale}`, () => {
      const tree = catalogue(locale);
      const t = createTranslator({
        locale,
        messages: { settings: tree },
        namespace: 'settings.plan',
        // Throw instead of printing the key, so a missing translation fails here rather
        // than showing "settings.plan…" to a merchant.
        onError: (error) => {
          throw error;
        },
      }) as unknown as (key: string, values?: Record<string, string | number>) => string;
      for (const [key, values] of USED) {
        expect(t(key, values), `${locale}: ${key}`).toBeTruthy();
      }
    });

    it(`has no leftover AI Suite or AI menu import copy in ${locale}`, () => {
      const plan = JSON.stringify((catalogue(locale) as { plan: Tree }).plan);
      expect(plan).not.toContain('AI Suite');
      expect(plan).not.toContain('aiSuite');
      expect(plan).not.toContain('aiMenuImport');
    });
  }
});
