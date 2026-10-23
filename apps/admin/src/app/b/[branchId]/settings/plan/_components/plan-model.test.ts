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
  withSeats,
  type PlanBranch,
} from './plan-model';

// The owner's own examples, from docs/PACKAGING-2026-10-24.md §1:
//
//   1 branch      $199 once, then  $49 / month
//   2 branches    $288 once, then  $98 / month
//   3 branches    $377 once, then $147 / month
//   one more branch for a restaurant that already paid: $89 once
//
// Every feature is in the plan, delivery included, so nothing here is priced per feature.
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

/** What listBillingProducts returns since 2026-10-24: the active products only (§4.1). */
const CATALOG: BillingProduct[] = [
  product({
    code: 'base',
    name: 'FavorNoms Plan',
    kind: 'plan',
    monthly_price: 49,
    one_time_price: 199,
    included_seats: 1,
    features: { card_payment: true, delivery: true },
  }),
  product({
    code: 'extra_branch',
    name: 'Additional branch',
    monthly_price: 49,
    one_time_price: 89,
    seats_per_unit: 1,
    is_quantity: true,
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

/**
 * The same catalog with the withdrawn delivery row still in it at its old prices, as a read of
 * every product (the platform console's) or a stale cache would return it. It must change
 * nothing on the bill.
 */
const WITH_OLD_DELIVERY: BillingProduct[] = [
  ...CATALOG,
  product({
    code: 'delivery',
    name: 'Delivery',
    monthly_price: 30,
    one_time_price: 59,
    is_quantity: true,
    features: { delivery: true },
  }),
];

const BRANCH_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const BRANCH_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const BRANCH_C = 'cccccccc-0000-4000-8000-000000000003';

const branch = (id: string, name: string): PlanBranch => ({ id, name });

const TWO_BRANCHES = [branch(BRANCH_A, 'Food Thai Thai'), branch(BRANCH_B, 'Riverside')];
const THREE_BRANCHES = [...TWO_BRANCHES, branch(BRANCH_C, 'Old Town')];

const sel = (over: Partial<PackageSelection> = {}): PackageSelection => ({
  planCode: 'base',
  branchSeats: 1,
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
  it('is $49 for one branch', () => {
    expect(planTotals(sel(), CATALOG, [TWO_BRANCHES[0]!], NOTHING_PAID).monthlyTotal).toBe(49);
  });

  it('is $98 for two branches, $49 each', () => {
    const totals = planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, NOTHING_PAID);
    expect(totals.monthlyTotal).toBe(98);
    expect(totals.perBranch).toEqual([
      { branchId: BRANCH_A, name: 'Food Thai Thai', monthly: 49 },
      { branchId: BRANCH_B, name: 'Riverside', monthly: 49 },
    ]);
  });

  it('is $147 for three branches', () => {
    expect(
      planTotals(sel({ branchSeats: 3 }), CATALOG, THREE_BRANCHES, NOTHING_PAID).monthlyTotal,
    ).toBe(147);
  });

  // The seat floor keeps the seats at or above the branches on screen, so the itemised
  // lines are the whole bill. A page whose arithmetic does not add up is exactly the
  // confusion the owner asked us to remove.
  it('adds up: the per-branch lines plus the unused seats ARE the total', () => {
    for (const [seats, branches] of [
      [1, [TWO_BRANCHES[0]!]],
      [2, TWO_BRANCHES],
      [3, THREE_BRANCHES],
      [5, TWO_BRANCHES],
    ] as Array<[number, PlanBranch[]]>) {
      const totals = planTotals(sel({ branchSeats: seats }), CATALOG, branches, NOTHING_PAID);
      const shown =
        totals.perBranch.reduce((sum, l) => sum + l.monthly, 0) +
        totals.unusedSeats * totals.seatMonthly;
      expect(shown).toBe(totals.monthlyTotal);
      expect(totals.monthlyTotal).toBe(49 * seats);
    }
  });

  it('counts a seat bought ahead of its branch', () => {
    const totals = planTotals(sel({ branchSeats: 3 }), CATALOG, TWO_BRANCHES, NOTHING_PAID);
    expect(totals.unusedSeats).toBe(1);
    expect(totals.seatMonthly).toBe(49);
    expect(totals.monthlyTotal).toBe(147);
  });

  it('stores the plan line and the additional branches, nothing else', () => {
    const lines = planTotals(sel({ branchSeats: 3 }), CATALOG, THREE_BRANCHES, NOTHING_PAID)
      .monthlyCatalogLines;
    expect(lines.map((l) => [l.code, l.qty, l.total])).toEqual([
      ['base', 1, 49],
      ['extra_branch', 2, 98],
    ]);
  });

  it('adds nothing for the withdrawn delivery product, even where a catalog still carries it', () => {
    for (const seats of [1, 2, 3]) {
      const branches = THREE_BRANCHES.slice(0, seats);
      const now = planTotals(sel({ branchSeats: seats }), CATALOG, branches, NOTHING_PAID);
      const stale = planTotals(sel({ branchSeats: seats }), WITH_OLD_DELIVERY, branches, NOTHING_PAID);
      expect(stale).toEqual(now);
      expect(stale.monthlyCatalogLines.some((l) => l.code === 'delivery')).toBe(false);
      expect(stale.oneTimeLines.some((l) => l.code === 'delivery')).toBe(false);
    }
  });
});

describe('what is paid once', () => {
  it('is $199 for a first purchase, the first branch included', () => {
    const totals = planTotals(sel(), CATALOG, [TWO_BRANCHES[0]!], NOTHING_PAID);
    expect(totals.oneTimeTotal).toBe(199);
    expect(totals.oneTimeLines.map((l) => l.code)).toEqual(['base']);
  });

  it('is $288 for two branches and $377 for three, bought at once', () => {
    expect(planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, NOTHING_PAID).oneTimeTotal).toBe(288);
    const three = planTotals(sel({ branchSeats: 3 }), CATALOG, THREE_BRANCHES, NOTHING_PAID);
    expect(three.oneTimeTotal).toBe(377);
    expect(three.oneTimeLines.map((l) => [l.code, l.qty, l.total])).toEqual([
      ['base', 1, 199],
      ['extra_branch', 2, 178],
    ]);
  });

  it('is $89 to add a branch once the plan is paid', () => {
    const paid = paidState({ basePaid: true, seatsPaid: 1 });
    const totals = planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, paid);
    expect(totals.oneTimeTotal).toBe(89);
    expect(totals.monthlyTotal).toBe(98);
  });

  it('charges nothing twice: branches already paid for cost nothing once', () => {
    const paid = paidState({ basePaid: true, seatsPaid: 2 });
    const totals = planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, paid);
    expect(totals.oneTimeTotal).toBe(0);
    expect(totals.oneTimeLines).toEqual([]);
  });

  it('never mixes the two totals', () => {
    const totals = planTotals(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES, NOTHING_PAID);
    expect(totals.oneTimeTotal).toBe(199 + 89);
    expect(totals.monthlyTotal).toBe(98);
  });
});

describe('the branch rows', () => {
  it('lists every branch at the same monthly price, and nothing else', () => {
    // No switch, no unlock, no "drops to": the row is the branch and what it costs.
    expect(branchRows(sel({ branchSeats: 2 }), CATALOG, TWO_BRANCHES)).toEqual([
      { id: BRANCH_A, name: 'Food Thai Thai', monthly: 49 },
      { id: BRANCH_B, name: 'Riverside', monthly: 49 },
    ]);
  });

  it('bills a branch that switched delivery off like any other', () => {
    // get_billing_overview's branches carry deliveryOn. It is not a billing matter (§3).
    const fromOverview = [
      { id: BRANCH_A, name: 'Food Thai Thai', deliveryOn: true },
      { id: BRANCH_B, name: 'Riverside', deliveryOn: false },
    ];
    const rows = branchRows(sel({ branchSeats: 2 }), CATALOG, fromOverview);
    expect(rows.map((r) => r.monthly)).toEqual([49, 49]);
    expect(planTotals(sel({ branchSeats: 2 }), CATALOG, fromOverview, NOTHING_PAID).monthlyTotal).toBe(98);
  });

  it('never re-sells the setup to a paying restaurant when the overview could not be read', () => {
    const paying = ent({ branchSeats: 2, branchesUsed: 2, deliveryBranchIds: [BRANCH_A] });
    const { branches, paid } = fallbackOverview(paying, [
      { id: BRANCH_A, name: 'Food Thai Thai' },
      { id: BRANCH_B, name: 'Riverside' },
    ]);
    expect(paid).toEqual({ basePaid: true, seatsPaid: 2 });
    expect(branches).toEqual(TWO_BRANCHES);
    expect(planTotals(sel({ branchSeats: 2 }), CATALOG, branches, paid).oneTimeTotal).toBe(0);
  });

  it('prices a trial against nothing paid when the overview could not be read', () => {
    // A trial has bought nothing, so converting it costs the first-time setup — the same figure
    // private.billing_price_one_time will charge.
    const trialing = ent({ planCode: 'trial', status: 'trialing', deliveryBranchIds: [BRANCH_A] });
    const { branches, paid } = fallbackOverview(trialing, [{ id: BRANCH_A, name: 'Food Thai Thai' }]);
    expect(paid).toEqual(NOTHING_PAID);
    expect(branches).toEqual([TWO_BRANCHES[0]]);
    expect(planTotals(sel(), CATALOG, branches, paid).oneTimeTotal).toBe(199);
  });
});

describe('the selection', () => {
  it('never drops below the branches already open', () => {
    const minSeats = minimumSeats(ent({ branchesUsed: 2, branchSeats: 2 }), TWO_BRANCHES);
    expect(minSeats).toBe(2);
    expect(withSeats(sel({ branchSeats: 2 }), 1, minSeats).branchSeats).toBe(2);
    expect(withSeats(sel({ branchSeats: 2 }), 5, minSeats).branchSeats).toBe(5);
    expect(withSeats(sel(), 500, minSeats).branchSeats).toBe(MAX_SEATS);
    expect(normalizeSelection(sel({ branchSeats: 0 }), minSeats)).toEqual(sel({ branchSeats: 2 }));
  });

  it('keeps a restaurant with more branches than the stepper offers at its own branch count', () => {
    // The cap is a stepper limit, not a floor-breaker: a request below the branches in use is
    // refused by the server (plan_limit_exceeded), so the page must never produce one.
    expect(withSeats(sel(), MAX_SEATS + 20, MAX_SEATS + 5).branchSeats).toBe(MAX_SEATS + 5);
  });

  it('opens on the plan and the branches the restaurant pays for, and nothing else', () => {
    const opening = openingSelection({
      entitlements: ent({ branchSeats: 2, branchesUsed: 2, deliveryBranchIds: [BRANCH_A, BRANCH_B] }),
      minSeats: 2,
    });
    expect(opening).toEqual({ planCode: 'base', branchSeats: 2 });
  });

  it('opens a trial on the plan it would buy', () => {
    const opening = openingSelection({
      entitlements: ent({ planCode: 'trial', status: 'trialing', branchSeats: 1 }),
      minSeats: 1,
    });
    expect(opening).toEqual({ planCode: 'base', branchSeats: 1 });
  });

  it('treats a trialing restaurant as a change, so it can be confirmed', () => {
    const trialing = ent({ planCode: 'trial', status: 'trialing', deliveryBranchIds: [BRANCH_A] });
    expect(isDirty(sel(), trialing)).toBe(true);
  });

  // The delivering branches used to be part of the selection, compared against the server's
  // list: whenever the two disagreed, "Confirm package" stayed lit with nothing to confirm.
  it('treats an unchanged package as clean, whichever branches deliver', () => {
    for (const delivering of [[], [BRANCH_A], [BRANCH_A, BRANCH_B]]) {
      const current = ent({ branchSeats: 2, branchesUsed: 2, deliveryBranchIds: delivering });
      expect(isDirty(sel({ branchSeats: 2 }), current), delivering.join()).toBe(false);
    }
  });

  it('sees a change in the branch count', () => {
    expect(isDirty(sel({ branchSeats: 3 }), ent({ branchSeats: 2, branchesUsed: 2 }))).toBe(true);
  });

  it('compares two selections by the plan and the branch count', () => {
    expect(sameSelection(sel({ branchSeats: 2 }), sel({ branchSeats: 2 }))).toBe(true);
    expect(sameSelection(sel({ branchSeats: 2 }), sel({ branchSeats: 3 }))).toBe(false);
    expect(selectionKey(sel({ branchSeats: 2 }))).not.toBe(selectionKey(sel({ branchSeats: 3 })));
  });

  it('reads a queued request back as a selection, ignoring a legacy delivery list', () => {
    // A row filed before 2026-10-24 still names the branches it wanted delivery at.
    const legacy = { plan_code: 'base', branch_seats: 2, delivery_branch_ids: [BRANCH_A] };
    expect(selectionFromRequest(legacy)).toEqual({ planCode: 'base', branchSeats: 2 });
    expect(sameSelection(selectionFromRequest(legacy), sel({ branchSeats: 2 }))).toBe(true);
  });
});

describe('the discount code', () => {
  const selection = sel({ branchSeats: 2 });
  const applied = {
    code: 'LAUNCH50',
    label: 'Launch offer',
    amountOff: 50,
    netTotal: 238,
    key: selectionKey(selection),
  };

  it('shows the server’s number, not one of its own', () => {
    expect(netOneTime(selection, 288, applied)).toBe(238);
    expect(submittableCode(selection, applied)).toBe('LAUNCH50');
  });

  it('re-prices at list price when the package changes under it', () => {
    const changed = withSeats(selection, 3, 1);
    expect(netOneTime(changed, 377, applied)).toBe(377);
    expect(submittableCode(changed, applied)).toBeNull();
  });

  it('re-prices at list price when the code is cleared', () => {
    expect(netOneTime(selection, 288, null)).toBe(288);
    expect(submittableCode(selection, null)).toBeNull();
  });
});

describe('the plain-language summary', () => {
  it('is the branches and the monthly total — "2 branches — $98 every month"', () => {
    expect(summaryFacts(sel({ branchSeats: 2 }), CATALOG, NOTHING_PAID)).toEqual({
      branches: 2,
      monthlyTotal: 98,
      oneTimeTotal: 288,
    });
  });

  it('counts the branches paid for, not only the ones open', () => {
    const facts = summaryFacts(sel({ branchSeats: 3 }), CATALOG, paidState({ basePaid: true, seatsPaid: 2 }));
    expect(facts).toEqual({ branches: 3, monthlyTotal: 147, oneTimeTotal: 89 });
  });
});

describe('the catalog is the only price list', () => {
  it('reads both prices of a product', () => {
    expect(priceOf(CATALOG, 'base')).toEqual({ monthly: 49, once: 199 });
    expect(priceOf(CATALOG, 'extra_branch')).toEqual({ monthly: 49, once: 89 });
  });

  it('prices nothing at all when the catalog could not be read', () => {
    const totals = planTotals(sel({ branchSeats: 2 }), [], TWO_BRANCHES, NOTHING_PAID);
    expect(totals.monthlyTotal).toBe(0);
    expect(totals.oneTimeTotal).toBe(0);
    expect(priceOf([], 'extra_branch')).toEqual({ monthly: 0, once: 0 });
  });

  // Those zeros are what a failed read produces (listBillingProducts answers an error with
  // []), and the page used to print them as a quote — "$0/mo", "$0 every month", "Nothing.
  // Everything … is already paid for." — with Confirm enabled. Two branches are $98 a month;
  // they must never read as free.
  it('refuses to quote from a catalog that could not be read', () => {
    expect(canQuote([], 'base')).toBe(false);
    expect(canQuote(CATALOG, 'base')).toBe(true);
  });

  it('refuses to quote when the plan or the additional branch is missing', () => {
    const without = (code: string) => CATALOG.filter((p) => p.code !== code);
    expect(canQuote(without('base'), 'base')).toBe(false);
    expect(canQuote(without('extra_branch'), 'base')).toBe(false);
    // An add-on that happens to share the plan's code is not the plan.
    expect(canQuote([...without('base'), product({ code: 'base' })], 'base')).toBe(false);
  });

  // The page reads active products only, and the delivery product is inactive since
  // 2026-10-24. Requiring it put every merchant on "Prices unavailable" — a suspended one too,
  // for whom this page is the only way back.
  it('quotes without the withdrawn delivery product', () => {
    expect(CATALOG.some((p) => p.code === 'delivery')).toBe(false);
    expect(canQuote(CATALOG, 'base')).toBe(true);
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
  ['now.nextPayment'],
  ['now.trialEnds'],
  ['now.noNextPayment'],
  ['now.includedTitle'],
  ['base.name'],
  // The owner's six included items (plan-view.tsx INCLUDED).
  ['base.included.allFeatures'],
  ['base.included.website'],
  ['base.included.operations'],
  ['base.included.drivers'],
  ['base.included.growth'],
  ['base.included.noCommissions'],
  ['branches.title'],
  ['branches.subtitle', { price: '$49' }],
  ['branches.subtitleNoPrice'],
  ['branches.empty'],
  ['branches.eachMonth', { price: '$49' }],
  ['branches.trialNote'],
  ['seats.title'],
  ['seats.body', { once: '$89', monthly: '$49' }],
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
  ['pay.unusedSeats', { count: 1 }],
  ['pay.setup.first'],
  ['pay.setup.extraBranch'],
  ['pay.total'],
  ['pay.summary.branches', { count: 2 }],
  ['pay.summary.line', { branches: '2 branches', price: '$98' }],
  ['pay.summary.plusOnce', { price: '$288' }],
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
  // Card billing (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §5).
  ['stripe.action.payNow', { amount: '$199' }],
  ['stripe.action.addCard', { date: '10/26/2026' }],
  ['stripe.action.confirmChange'],
  ['stripe.action.continue'],
  ['stripe.action.processing'],
  ['stripe.footnote.firstLater', { date: '10/26/2026', monthly: '$98' }],
  ['stripe.footnote.firstNow', { monthly: '$98' }],
  ['stripe.footnote.change', { monthly: '$98' }],
  ['stripe.footnote.renews', { monthly: '$98' }],
  ['stripe.prorationNote'],
  ['stripe.trialNote.later', { date: '10/26/2026' }],
  ['stripe.trialNote.now'],
  ['stripe.trialBody'],
  ['stripe.onceAwaiting'],
  ['stripe.newSeats', { count: 1 }],
  ['stripe.renewBody'],
  ['stripe.noTrialBody'],
  ['stripe.replaceBody', { summary: '2 branches' }],
  ['stripe.chargeDialog.title'],
  ['stripe.chargeDialog.amount', { amount: '$89', card: 'Visa •••• 4242' }],
  ['stripe.chargeDialog.proration', { monthly: '$147' }],
  ['stripe.chargeDialog.nothing'],
  ['stripe.chargeDialog.cardOnFile'],
  ['stripe.chargeDialog.confirm'],
  ['stripe.now.nextCharge'],
  ['stripe.now.endsOn'],
  ['stripe.now.chargeValue', { amount: '$98', date: '10/26/2026' }],
  ['stripe.pending.title'],
  ['stripe.pending.titleSent', { date: '9/26/2026' }],
  ['stripe.pending.body'],
  ['stripe.pending.badge'],
  ['stripe.pending.orPayByCard'],
  ['stripe.result.confirmingTitle'],
  ['stripe.result.confirmingBody'],
  ['stripe.result.activeTitle'],
  ['stripe.result.activeBody'],
  ['stripe.result.processingTitle'],
  ['stripe.result.processingBody'],
  ['stripe.result.checkAgain'],
  ['stripe.result.appliedTitle'],
  ['stripe.result.appliedBody'],
  ['stripe.result.cancelledTitle'],
  ['stripe.result.cancelledBody'],
  ['stripe.pastDue.title'],
  ['stripe.pastDue.body', { date: '11/2/2026' }],
  ['stripe.pastDue.bodyNoDate'],
  ['stripe.pastDue.cta'],
  ['stripe.cancelling.title', { date: '10/26/2026' }],
  ['stripe.cancelling.titleNoDate'],
  ['stripe.cancelling.body'],
  ['stripe.billing.title'],
  ['stripe.billing.subtitle'],
  ['stripe.billing.nextCharge'],
  ['stripe.billing.noNextCharge'],
  ['stripe.billing.cancelsOn', { date: '10/26/2026' }],
  ['stripe.billing.card'],
  ['stripe.billing.cardValue', { brand: 'Visa', last4: '4242' }],
  ['stripe.billing.cardExpires', { date: '08/27' }],
  ['stripe.billing.noCard'],
  ['stripe.billing.cardExpiring'],
  ['stripe.billing.lastInvoice'],
  ['stripe.billing.invoiceValue', { amount: '$288', status: 'Paid' }],
  ['stripe.billing.viewInvoice'],
  ['stripe.billing.noInvoice'],
  ['stripe.billing.manage'],
  ['stripe.billing.manageHint'],
  ['stripe.invoiceStatus.paid'],
  ['stripe.invoiceStatus.open'],
  ['stripe.invoiceStatus.void'],
  ['stripe.invoiceStatus.other'],
  ['stripe.decision.paidOn', { date: '9/26/2026' }],
  ['stripe.decision.paid'],
  ['stripe.errors.requestGone'],
  ['stripe.errors.startFailed'],
  ['stripe.errors.portalFailed'],
  ['stripe.errors.portalOff'],
  ['stripe.errors.noCustomer'],
  ['stripe.errors.chargedNotApplied'],
  ['stripe.errors.needsTeam'],
  // Review fixes (docs/PLATFORM-BILLING-STRIPE-2026-09-26.md §9.9).
  ['stripe.action.finishPayment'],
  ['stripe.action.finishFirst'],
  ['stripe.action.checking'],
  ['stripe.action.sendToTeam'],
  ['stripe.pending.invoiceTitle'],
  ['stripe.pending.invoiceBody'],
  ['stripe.pending.unconfirmedTitle'],
  ['stripe.pending.unconfirmedBody'],
  ['stripe.pending.unconfirmedBadge'],
  ['stripe.pending.pausedTitle'],
  ['stripe.pending.pausedBody'],
  ['stripe.onceSettling'],
  ['stripe.onceUnconfirmed'],
  ['stripe.replaceBodyUnconfirmed', { summary: '2 branches' }],
  ['stripe.result.refundedStaleTitle'],
  ['stripe.result.refundedStaleBody'],
  ['stripe.result.refundedFailedTitle'],
  ['stripe.result.refundedFailedBody'],
  ['stripe.errors.chargedRefunded'],
  ['stripe.errors.resultUnknown'],
  ['stripe.errors.paymentInProgress'],
  ['stripe.errors.planLimit'],
  ['stripe.errors.cardPaused'],
  ['stripe.errors.changeConflict'],
  ['stripe.errors.paymentExpired'],
  ['stripe.errors.changeNotApplied'],
  ['stripe.errors.busy'],
  ['stripe.result.notAppliedTitle'],
  ['stripe.result.notAppliedBody'],
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

    it(`sells no delivery switch, unlock or add-on in ${locale}`, () => {
      // Delivery is in the plan at every branch (docs/PACKAGING-2026-10-24.md §5): the keys
      // that priced it, switched it or warned about losing it are gone, and so is the summary
      // sentence that named the delivering branches.
      const plan = (catalogue(locale) as { plan: Tree }).plan as Record<string, Tree>;
      for (const key of ['delivery', 'deliveryNone', 'deliveryTrial']) {
        expect(plan.now![key], `${locale}: now.${key}`).toBeUndefined();
      }
      for (const key of ['delivery', 'switchLabel', 'costOnceAndMonthly', 'costMonthly', 'alreadyUnlocked', 'offWarning', 'dropsTo']) {
        expect(plan.branches![key], `${locale}: branches.${key}`).toBeUndefined();
      }
      expect(plan.pay!.withDelivery).toBeUndefined();
      expect(plan.pay!.forBranch).toBeUndefined();
      expect((plan.pay!.summary as Tree).delivery).toBeUndefined();
      expect(JSON.stringify(plan)).not.toContain('{delivery}');
    });

    it(`hardcodes no price in ${locale}`, () => {
      // Every figure comes from billing_products through a {price}-style placeholder.
      const settings = JSON.stringify(catalogue(locale));
      expect(settings).not.toMatch(/\$\s?\d/);
    });
  }
});
