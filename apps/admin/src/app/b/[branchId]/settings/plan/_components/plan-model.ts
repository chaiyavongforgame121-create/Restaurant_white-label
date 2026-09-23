// The plan page's arithmetic, with no React in it.
//
// Since 2026-09-23 the page reads money in two directions at once: what is paid ONCE today
// (the base, a new branch seat, a branch's delivery unlock) and what is paid EVERY MONTH
// afterwards. The owner's one instruction about the page was that the two must never be
// added together — "ทำให้มันเข้าใจง่ายหน่อยเดี๋ยวผู้ใช้จะงง". Keeping the derivation here
// means the view only renders numbers it was handed, and those numbers can be checked
// against the owner's own examples (docs/PACKAGING-2026-09-23.md §1) in a unit test.
//
// Every price comes from the catalog (billing_products). Nothing in this file knows that
// the base is 228 or that a branch is 29, and the server re-prices every purchase anyway
// (private.billing_price_one_time, public.request_package_change) — this module exists so
// the merchant reads the same figure before the server says it.

import {
  ADDON_DELIVERY,
  NOTHING_PAID,
  PLAN_TRIAL,
  PRODUCT_EXTRA_BRANCH,
  branchMonthly,
  currentSelection,
  monthlyLines,
  oneTimeLines,
  packageMonthlyTotal,
  packageOneTimeTotal,
  type BillingPaidState,
  type BillingProduct,
  type Entitlements,
  type PackageSelection,
  type PriceLine,
} from '@favornoms/shared';

/** One branch of the restaurant, as get_billing_overview describes it. */
export interface PlanBranch {
  id: string;
  name: string;
  /** It delivers today (ignores the deadline, so a lapsed merchant still sees their switches). */
  deliveryActive: boolean;
  /** Its one-time unlock was paid at some point, so switching it back on costs nothing once. */
  deliveryUnlocked: boolean;
}

/**
 * A catalog row's two prices. Zero when the product is missing — never a guess — which is
 * why the page asks canQuote() before it shows any of them.
 */
export interface CatalogPrice {
  monthly: number;
  once: number;
}

export function priceOf(catalog: BillingProduct[], code: string): CatalogPrice {
  const product = catalog.find((p) => p.code === code);
  return {
    monthly: Number(product?.monthly_price ?? 0),
    once: Number(product?.one_time_price ?? 0),
  };
}

/**
 * Can this catalog price the selection at all?
 *
 * listBillingProducts answers a failed read with an empty list, and every price derived from an
 * empty list is 0. The page used to render those zeros as a quote — "$0/mo" on every branch,
 * "$0 every month", "Nothing. Everything in this package is already paid for." — with Confirm
 * still enabled, so a merchant could file a request believing it was free. The catalog always
 * holds the plan being bought, the seat and the delivery add-on (every branch row offers the
 * delivery switch), so if any one of them is missing the read failed, and the page says that
 * instead of quoting. The landing page makes the same call when its catalog read fails: it
 * leaves the numbers out rather than inventing them.
 */
export function canQuote(catalog: BillingProduct[], planCode: string): boolean {
  const has = (code: string, kind?: string) =>
    catalog.some((p) => p.code === code && (kind === undefined || p.kind === kind));
  return has(planCode, 'plan') && has(PRODUCT_EXTRA_BRANCH) && has(ADDON_DELIVERY);
}

/** The catalog's name for a product, falling back to its code rather than to nothing. */
export function productName(catalog: BillingProduct[], code: string): string {
  return catalog.find((p) => p.code === code)?.name ?? code;
}

/**
 * What the page falls back to when `get_billing_overview` cannot be read — an old deployment
 * that predates it, or a refused read — built from the entitlements and the branch list.
 *
 * Losing the overview must not turn into a sales pitch: a restaurant that already pays for its
 * base and its seats would otherwise be quoted the base all over again, and a branch that
 * delivers on a paid plan would be asked to unlock delivery a second time. This mirrors what
 * private.billing_paid_state() derives when the ledger is empty.
 *
 * A branch is unlocked only when that paid state says so. "Delivers today" is not the same
 * thing: on a trial every branch delivers and no $59 was ever spent, and reading delivery as
 * proof of payment hid the unlock from the branch row while the server still charged it — the
 * trial case the overview path was fixed for (see branchRows()).
 */
export function fallbackOverview(
  entitlements: Entitlements,
  rows: Array<{ id: string; name: string }>,
): { branches: PlanBranch[]; paid: BillingPaidState } {
  const paidPlan = entitlements.planCode !== 'none' && entitlements.planCode !== PLAN_TRIAL;
  const paid: BillingPaidState = paidPlan
    ? {
        basePaid: true,
        seatsPaid: Math.max(1, entitlements.branchSeats),
        deliveryUnlockedBranchIds: [...entitlements.deliveryBranchIds],
      }
    : NOTHING_PAID;
  const delivers = new Set(entitlements.deliveryBranchIds);
  const unlocked = new Set(paid.deliveryUnlockedBranchIds);
  return {
    paid,
    branches: rows.map((b) => ({
      id: b.id,
      name: b.name,
      deliveryActive: delivers.has(b.id),
      deliveryUnlocked: unlocked.has(b.id),
    })),
  };
}

// --- the selection -----------------------------------------------------------

/**
 * The most branches the stepper offers. It sits inside the range request_package_change and
 * validate_billing_discount accept, so nothing the page can send is refused for its size; a
 * restaurant with more branches than this still gets a floor of its own branch count from
 * minimumSeats(), which the clamps below let through.
 */
export const MAX_SEATS = 99;

/**
 * A seat can never be dropped below the branches already open: the database trigger would
 * refuse the write anyway, so refusing it here keeps the quoted total honest. Hidden
 * branches hold no seat, which is why this counts `branchesUsed` and not every row.
 */
export function minimumSeats(entitlements: Entitlements, branches: PlanBranch[]): number {
  return Math.max(1, entitlements.branchesUsed, branches.length);
}

/**
 * Whole seats inside the allowed range, and delivery only on branches that exist.
 *
 * An id the restaurant does not own would be dropped by the server anyway (every RPC
 * re-reads the branches), so dropping it here keeps the page's quote and the server's
 * price the same number.
 */
export function normalizeSelection(
  sel: PackageSelection,
  branches: PlanBranch[],
  minSeats: number,
): PackageSelection {
  const known = new Set(branches.map((b) => b.id));
  return {
    planCode: sel.planCode,
    branchSeats: Math.max(minSeats, Math.min(MAX_SEATS, Math.trunc(sel.branchSeats || 1))),
    deliveryBranchIds: [...new Set(sel.deliveryBranchIds ?? [])].filter((id) => known.has(id)),
  };
}

/** What the page opens on, and which branch row the merchant was sent to look at. */
export interface OpeningState {
  selection: PackageSelection;
  /** The branch whose switch the deep link is about, for highlighting its row. */
  focusBranchId: string | null;
}

/**
 * The selection the page starts from, honouring the deep links the rest of the app sends.
 *
 * `?add=delivery&branch=<uuid>` comes from the branch settings upsell: the merchant already
 * said which branch they want delivery on, and making them find and flip that switch again
 * is where the intent used to get lost. Without a branch id there is nothing to guess at
 * unless the restaurant has exactly one branch — turning delivery on everywhere because a
 * link said "delivery" would quote a bill nobody asked for.
 */
export function openingSelection(args: {
  entitlements: Entitlements;
  branches: PlanBranch[];
  minSeats: number;
  addDelivery: boolean;
  branchParam: string | null;
}): OpeningState {
  const { entitlements, branches, minSeats, addDelivery, branchParam } = args;
  const start = normalizeSelection(currentSelection(entitlements), branches, minSeats);
  const focus = branches.find((b) => b.id === branchParam)?.id ?? null;
  const only = branches.length === 1 ? branches[0] : undefined;
  const target = focus ?? (addDelivery && only ? only.id : null);
  if (!target || !addDelivery) return { selection: start, focusBranchId: focus };
  return { selection: toggleDelivery(start, target, true), focusBranchId: target };
}

export function toggleDelivery(
  sel: PackageSelection,
  branchId: string,
  on: boolean,
): PackageSelection {
  const ids = sel.deliveryBranchIds.filter((id) => id !== branchId);
  return { ...sel, deliveryBranchIds: on ? [...ids, branchId] : ids };
}

export function withSeats(sel: PackageSelection, seats: number, minSeats: number): PackageSelection {
  return { ...sel, branchSeats: Math.max(minSeats, Math.min(MAX_SEATS, Math.trunc(seats || 1))) };
}

export function sameSelection(a: PackageSelection, b: PackageSelection): boolean {
  return selectionKey(a) === selectionKey(b);
}

/**
 * A stable string for one selection. It is what tells the page that a discount quote was
 * priced against something else: flip a switch and the server's number no longer applies,
 * so it is dropped and the code re-priced rather than shown against the wrong total.
 */
export function selectionKey(sel: PackageSelection): string {
  const ids = [...new Set(sel.deliveryBranchIds ?? [])].sort();
  return `${sel.planCode}|${Math.max(1, Math.trunc(sel.branchSeats || 1))}|${ids.join(',')}`;
}

/** The selection a queued or decided request asks for, as the page's own shape. */
export function selectionFromRequest(req: {
  plan_code: string;
  branch_seats: number;
  delivery_branch_ids: string[];
}): PackageSelection {
  return {
    planCode: req.plan_code,
    branchSeats: Math.max(1, Math.trunc(Number(req.branch_seats) || 1)),
    deliveryBranchIds: Array.isArray(req.delivery_branch_ids) ? [...req.delivery_branch_ids] : [],
  };
}

/**
 * Does this selection differ from what the restaurant is on right now?
 *
 * Compared against the RAW entitlements, not against currentSelection(): a trialing
 * merchant is on `trial` and every selection they can make is `base`, so their page must
 * offer to confirm a package rather than tell them they already have this one.
 */
export function isDirty(sel: PackageSelection, entitlements: Entitlements): boolean {
  return !sameSelection(sel, {
    planCode: entitlements.planCode,
    branchSeats: Math.max(1, entitlements.branchSeats),
    deliveryBranchIds: entitlements.deliveryBranchIds,
  });
}

// --- the branch rows ---------------------------------------------------------

/** One row of "Your branches": what it costs, and what flipping its switch would do. */
export interface BranchRow {
  id: string;
  name: string;
  /** Delivery is on for this branch in the CURRENT selection. */
  delivers: boolean;
  /** It delivers today, so switching it off takes delivery away from a live storefront. */
  deliversToday: boolean;
  /** Its one-time unlock is already bought — switching it back on costs nothing once. */
  unlocked: boolean;
  /** What this branch adds to the monthly bill under the current selection. */
  monthly: number;
  /** What it would cost a month without delivery — the figure it drops to when switched off. */
  monthlyWithoutDelivery: number;
  /** The delivery add-on's monthly price, shown as "+$29/mo" beside an off switch. */
  deliveryMonthly: number;
  /** The unlock, or 0 when this branch has already been unlocked once. */
  deliveryOnce: number;
  /** Switched off in this selection but delivering today: the storefront loses delivery. */
  losingDelivery: boolean;
}

export function branchRows(
  sel: PackageSelection,
  catalog: BillingProduct[],
  branches: PlanBranch[],
  paid: BillingPaidState,
): BranchRow[] {
  const chosen = new Set(sel.deliveryBranchIds);
  const unlocked = new Set(paid.deliveryUnlockedBranchIds ?? []);
  const delivery = priceOf(catalog, ADDON_DELIVERY);
  return branches.map((b) => {
    const delivers = chosen.has(b.id);
    // "Unlocked" is what the LEDGER says was bought, and nothing else. It used to include
    // `b.deliveryActive` ("this branch delivers today") on the theory that delivering implies
    // having paid — true for a paying tenant, false for a trial, where every branch delivers
    // because the trial grants it and no $59 was ever spent (packaging §1, §3.2: "No
    // branch_addons row is written for a trial"). On a trial that made the switch say
    // "+$29/mo" and nothing more, while oneTimeLines — and private.billing_price_one_time,
    // which is what actually charges — added the $59 to "Pay once today" from
    // deliveryUnlockedBranchIds alone. Every trial converting to Base was shown a one-time
    // total $59 higher than the switches it had just read.
    //
    // For a paying tenant this drops nothing: outside the trial a branch only delivers while
    // it has an ACTIVE branch_addons row, and any branch_addons row (active or not) already
    // puts the branch in deliveryUnlockedBranchIds. So the two remaining terms are the same
    // set, plus the branches whose switch is currently off — which is the whole point of
    // "paid once ever". A charge that is only PENDING on a request unlocks nothing: bought
    // means paid, and billing_paid_state counts paid charges alone.
    const isUnlocked = unlocked.has(b.id) || b.deliveryUnlocked;
    return {
      id: b.id,
      name: b.name,
      delivers,
      deliversToday: b.deliveryActive,
      unlocked: isUnlocked,
      monthly: branchMonthly(sel, catalog, b.id),
      monthlyWithoutDelivery: branchMonthly(
        { ...sel, deliveryBranchIds: sel.deliveryBranchIds.filter((id) => id !== b.id) },
        catalog,
        b.id,
      ),
      deliveryMonthly: delivery.monthly,
      deliveryOnce: isUnlocked ? 0 : delivery.once,
      losingDelivery: b.deliveryActive && !delivers,
    };
  });
}

// --- the two totals ----------------------------------------------------------

/** One line of "Then every month": a branch, or the seats bought ahead of their branches. */
export interface MonthlyLine {
  /** Null on the "seats not used yet" line, which belongs to no branch. */
  branchId: string | null;
  name: string | null;
  monthly: number;
  delivers: boolean;
}

export interface PlanTotals {
  seats: number;
  /** $29 × branches + $29 × delivery branches. */
  monthlyTotal: number;
  /** The catalog lines the database actually stores, for the platform console's view of it. */
  monthlyCatalogLines: PriceLine[];
  /** The same money, itemised the way a merchant counts it: one line per branch. */
  perBranch: MonthlyLine[];
  /** Seats paid for but not yet turned into a branch. Zero in the ordinary case. */
  unusedSeats: number;
  /** What one branch costs a month before delivery, for the unused-seat line. */
  seatMonthly: number;
  /** Only what is NOT already bought. Empty when nothing one-time is owed. */
  oneTimeLines: PriceLine[];
  oneTimeTotal: number;
}

/**
 * Both totals, kept apart on purpose.
 *
 * The per-branch itemisation and the catalog lines describe the SAME monthly total from two
 * sides; the test pins that they agree, because a page whose arithmetic does not add up is
 * exactly the confusion the owner asked us to remove. They agree because the seat floor
 * (minimumSeats) keeps the seats at or above the branches being listed.
 */
export function planTotals(
  sel: PackageSelection,
  catalog: BillingProduct[],
  branches: PlanBranch[],
  paid: BillingPaidState,
): PlanTotals {
  const seats = Math.max(1, Math.trunc(sel.branchSeats || 1));
  const chosen = new Set(sel.deliveryBranchIds);
  // A branch id that is in no delivery list prices a plain seat, which is what a seat
  // bought ahead of its branch costs.
  const seatMonthly = branchMonthly(sel, catalog, '');
  return {
    seats,
    monthlyTotal: packageMonthlyTotal(sel, catalog),
    monthlyCatalogLines: monthlyLines(sel, catalog),
    perBranch: branches.map((b) => ({
      branchId: b.id,
      name: b.name,
      monthly: branchMonthly(sel, catalog, b.id),
      delivers: chosen.has(b.id),
    })),
    unusedSeats: Math.max(0, seats - branches.length),
    seatMonthly,
    oneTimeLines: oneTimeLines(sel, catalog, paid),
    oneTimeTotal: packageOneTimeTotal(sel, catalog, paid),
  };
}

// --- the plain-language summary ----------------------------------------------

export interface SummaryFacts {
  branches: number;
  deliveryNames: string[];
  monthlyTotal: number;
  oneTimeTotal: number;
}

/**
 * "2 branches, delivery at Food Thai Thai — $87 every month" in parts, so each language
 * orders the sentence itself. The branch count is the SEATS, not the rows: a merchant who
 * just bought a third branch is paying for three.
 */
export function summaryFacts(
  sel: PackageSelection,
  catalog: BillingProduct[],
  branches: PlanBranch[],
  paid: BillingPaidState,
): SummaryFacts {
  const names = new Map(branches.map((b) => [b.id, b.name]));
  return {
    branches: Math.max(1, Math.trunc(sel.branchSeats || 1)),
    // In the order the branches are listed, so the sentence reads the way the page does.
    deliveryNames: branches
      .filter((b) => sel.deliveryBranchIds.includes(b.id))
      .map((b) => names.get(b.id) ?? '')
      .filter((n) => n.length > 0),
    monthlyTotal: packageMonthlyTotal(sel, catalog),
    oneTimeTotal: packageOneTimeTotal(sel, catalog, paid),
  };
}

/**
 * Names as a sentence lists them, in the reader's language. Falls back to commas where
 * Intl.ListFormat is missing rather than losing the names.
 */
export function joinNames(names: string[], intlLocale: string): string {
  if (names.length === 0) return '';
  try {
    return new Intl.ListFormat(intlLocale, { style: 'long', type: 'conjunction' }).format(names);
  } catch {
    return names.join(', ');
  }
}

// --- the discount code -------------------------------------------------------

/**
 * A code the SERVER priced, and the selection it was priced against.
 *
 * `netTotal` is the server's number and is what the page shows; the client never subtracts
 * a discount itself. `key` is what makes clearing or changing the selection re-price: a
 * quote for another selection is simply not applied.
 */
export interface AppliedDiscount {
  code: string;
  label: string | null;
  amountOff: number;
  netTotal: number;
  key: string;
}

/** The one-time total as the merchant pays it: the server's discounted figure when it fits. */
export function netOneTime(
  sel: PackageSelection,
  oneTimeTotal: number,
  applied: AppliedDiscount | null,
): number {
  if (!applied || applied.key !== selectionKey(sel)) return oneTimeTotal;
  return Math.max(0, applied.netTotal);
}

/** The code to send with the purchase: only one the server already accepted for THIS selection. */
export function submittableCode(
  sel: PackageSelection,
  applied: AppliedDiscount | null,
): string | null {
  return applied && applied.key === selectionKey(sel) ? applied.code : null;
}

/** The catalog code of the seat product, so the view never spells it out. */
export const SEAT_CODE = PRODUCT_EXTRA_BRANCH;
export const DELIVERY_CODE = ADDON_DELIVERY;
