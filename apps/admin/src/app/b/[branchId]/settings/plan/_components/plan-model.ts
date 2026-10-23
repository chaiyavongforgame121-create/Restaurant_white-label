// The plan page's arithmetic, with no React in it.
//
// The page reads money in two directions at once: what is paid ONCE today (the plan's
// first-time setup, a new branch's setup) and what is paid EVERY MONTH afterwards. The
// owner's one instruction about the page was that the two must never be added together —
// "ทำให้มันเข้าใจง่ายหน่อยเดี๋ยวผู้ใช้จะงง". Keeping the derivation here means the view only
// renders numbers it was handed, and those numbers can be checked against the owner's own
// examples (docs/PACKAGING-2026-10-24.md §1) in a unit test.
//
// Since 2026-10-24 there is one plan with every feature in it. Delivery is no longer bought
// per branch, so nothing here knows which branches deliver: that is a switch in branch
// settings, not a line on the bill (§3).
//
// Every price comes from the catalog (billing_products). Nothing in this file knows that
// the setup is 199 or that a branch is 49, and the server re-prices every purchase anyway
// (private.billing_price_one_time, public.request_package_change) — this module exists so
// the merchant reads the same figure before the server says it.

import {
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

/**
 * One branch of the restaurant, as the bill lists it. get_billing_overview also says whether
 * the branch delivers now; the page does not read it, because a branch that switched delivery
 * off pays what every other branch pays, and that switch is not a billing matter.
 */
export interface PlanBranch {
  id: string;
  name: string;
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
 * holds the plan being bought and the additional branch (every page offers "Add a branch"),
 * so if either is missing the read failed, and the page says that instead of quoting. The
 * landing page makes the same call when its catalog read fails: it leaves the numbers out
 * rather than inventing them.
 *
 * The withdrawn delivery product is NOT required. It is inactive since 2026-10-24 and the page
 * reads active products only, so asking for it would put every merchant — a suspended one too,
 * for whom this page is the only way back — on "Prices unavailable".
 */
export function canQuote(catalog: BillingProduct[], planCode: string): boolean {
  const has = (code: string, kind?: string) =>
    catalog.some((p) => p.code === code && (kind === undefined || p.kind === kind));
  return has(planCode, 'plan') && has(PRODUCT_EXTRA_BRANCH);
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
 * plan and its branches would otherwise be quoted the first-time setup all over again. This
 * mirrors what private.billing_paid_state() derives when the ledger is empty. A trial has
 * bought nothing, so it prices against NOTHING_PAID, exactly as the server will.
 */
export function fallbackOverview(
  entitlements: Entitlements,
  rows: Array<{ id: string; name: string }>,
): { branches: PlanBranch[]; paid: BillingPaidState } {
  const paidPlan = entitlements.planCode !== 'none' && entitlements.planCode !== PLAN_TRIAL;
  const paid: BillingPaidState = paidPlan
    ? { basePaid: true, seatsPaid: Math.max(1, entitlements.branchSeats) }
    : NOTHING_PAID;
  return {
    paid,
    branches: rows.map((b) => ({ id: b.id, name: b.name })),
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

/** Whole seats inside the allowed range. */
export function normalizeSelection(sel: PackageSelection, minSeats: number): PackageSelection {
  return {
    planCode: sel.planCode,
    branchSeats: Math.max(minSeats, Math.min(MAX_SEATS, Math.trunc(sel.branchSeats || 1))),
  };
}

/**
 * The selection the page starts from: the plan the restaurant is on (a trial opens on the
 * plan it would buy), with the branches it pays for.
 *
 * There is no deep link to honour any more. `?add=delivery&branch=<uuid>` used to switch a
 * branch's delivery on here; delivery is in the plan now, and a link still carrying it opens
 * the page as it is.
 */
export function openingSelection(args: {
  entitlements: Entitlements;
  minSeats: number;
}): PackageSelection {
  return normalizeSelection(currentSelection(args.entitlements), args.minSeats);
}

export function withSeats(sel: PackageSelection, seats: number, minSeats: number): PackageSelection {
  return { ...sel, branchSeats: Math.max(minSeats, Math.min(MAX_SEATS, Math.trunc(seats || 1))) };
}

export function sameSelection(a: PackageSelection, b: PackageSelection): boolean {
  return selectionKey(a) === selectionKey(b);
}

/**
 * A stable string for one selection. It is what tells the page that a discount quote was
 * priced against something else: change the branch count and the server's number no longer
 * applies, so it is dropped and the code re-priced rather than shown against the wrong total.
 */
export function selectionKey(sel: PackageSelection): string {
  return `${sel.planCode}|${Math.max(1, Math.trunc(sel.branchSeats || 1))}`;
}

/**
 * The selection a queued or decided request asks for, as the page's own shape.
 *
 * A request filed before 2026-10-24 also names the branches it wanted to deliver from
 * (delivery_branch_ids). That is not read: nothing the page can send carries it any more, so
 * keeping it would make the request look different from the very selection that filed it.
 */
export function selectionFromRequest(req: {
  plan_code: string;
  branch_seats: number;
}): PackageSelection {
  return {
    planCode: req.plan_code,
    branchSeats: Math.max(1, Math.trunc(Number(req.branch_seats) || 1)),
  };
}

/**
 * Does this selection differ from what the restaurant is on right now?
 *
 * Compared against the RAW entitlements, not against currentSelection(): a trialing
 * merchant is on `trial` and every selection they can make is `base`, so their page must
 * offer to confirm a package rather than tell them they already have this one. The plan and
 * the branch count are the whole selection — the delivering branches used to be part of it,
 * and a list the page and the server read differently left "Confirm package" lit with
 * nothing to confirm.
 */
export function isDirty(sel: PackageSelection, entitlements: Entitlements): boolean {
  return !sameSelection(sel, {
    planCode: entitlements.planCode,
    branchSeats: Math.max(1, entitlements.branchSeats),
  });
}

// --- the branch rows ---------------------------------------------------------

/** One row of "Your branches": the branch and what it adds to the monthly bill. */
export interface BranchRow {
  id: string;
  name: string;
  /** What this branch adds to the monthly bill under the current selection. */
  monthly: number;
}

/** Every branch costs the same a month, so a row is its name and that one price. */
export function branchRows(
  sel: PackageSelection,
  catalog: BillingProduct[],
  branches: PlanBranch[],
): BranchRow[] {
  const monthly = branchMonthly(sel, catalog);
  return branches.map((b) => ({ id: b.id, name: b.name, monthly }));
}

// --- the two totals ----------------------------------------------------------

/** One line of "Then every month": a branch, or the seats bought ahead of their branches. */
export interface MonthlyLine {
  /** Null on the "seats not used yet" line, which belongs to no branch. */
  branchId: string | null;
  name: string | null;
  monthly: number;
}

export interface PlanTotals {
  seats: number;
  /** One branch's monthly price × branches. */
  monthlyTotal: number;
  /** The catalog lines the database actually stores, for the platform console's view of it. */
  monthlyCatalogLines: PriceLine[];
  /** The same money, itemised the way a merchant counts it: one line per branch. */
  perBranch: MonthlyLine[];
  /** Seats paid for but not yet turned into a branch. Zero in the ordinary case. */
  unusedSeats: number;
  /** What one branch costs a month, for the unused-seat line. */
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
  // A seat bought ahead of its branch costs what a branch costs.
  const seatMonthly = branchMonthly(sel, catalog);
  return {
    seats,
    monthlyTotal: packageMonthlyTotal(sel, catalog),
    monthlyCatalogLines: monthlyLines(sel, catalog),
    perBranch: branches.map((b) => ({
      branchId: b.id,
      name: b.name,
      monthly: seatMonthly,
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
  monthlyTotal: number;
  oneTimeTotal: number;
}

/**
 * "2 branches — $98 every month" in parts, so each language orders the sentence itself.
 * The branch count is the SEATS, not the rows: a merchant who just bought a third branch is
 * paying for three. The same two facts summarise a filed or decided request (filedFacts in
 * plan-copy.ts), so every banner reads the sentence the same way.
 */
export function summaryFacts(
  sel: PackageSelection,
  catalog: BillingProduct[],
  paid: BillingPaidState,
): SummaryFacts {
  return {
    branches: Math.max(1, Math.trunc(sel.branchSeats || 1)),
    monthlyTotal: packageMonthlyTotal(sel, catalog),
    oneTimeTotal: packageOneTimeTotal(sel, catalog, paid),
  };
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
