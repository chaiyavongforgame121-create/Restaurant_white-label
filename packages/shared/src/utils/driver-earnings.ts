// A rider can be approved at several restaurants at once and each one settles its own money:
// `request_driver_withdrawal` tags only that branch's accrued, untagged ledger rows and pays
// the sum of exactly those. So a flat "unpaid" number across restaurants is not an amount
// anybody can ever be paid — it has to be folded into per-restaurant piles that match what a
// request would actually move. Every rider screen that shows money folds it here.

/** What the rider screens select off a branch so a row can name the brand, not just the shop. */
export interface EarningsBranchRef {
  name: string;
  restaurant: { name: string } | null;
}

/** PostgREST hands numerics back as strings on some drivers, hence the widened money type. */
export interface DriverLedgerEntry {
  branch_id: string;
  base_pay: number | string | null;
  distance_pay: number | string | null;
  tip_net: number | string | null;
  total: number | string | null;
  status: string;
  withdrawal_id: string | null;
  branch: EarningsBranchRef | null;
}

export interface EarningsAmounts {
  /** Accrued and attached to no request: exactly what a new request would settle. */
  available: number;
  /** Accrued but already tagged to an open request — real money, but not requestable twice. */
  requested: number;
  paid: number;
  /** available + requested + paid, i.e. everything this restaurant has ever owed. */
  lifetime: number;
  deliveries: number;
  /** Deliveries behind `available` — the count the RPC would report back for a new request. */
  availableDeliveries: number;
  base: number;
  distance: number;
  tip: number;
}

export interface RestaurantEarnings extends EarningsAmounts {
  branchId: string;
  /** The brand the rider applied to — the label every screen leads with. */
  restaurantName: string;
  /** The shop they ride for. Equal to restaurantName when the tenant never named it apart. */
  branchName: string;
}

export interface DriverEarningsSummary {
  restaurants: RestaurantEarnings[];
  totals: EarningsAmounts;
  /** How many restaurants the rider has ever earned from; drives one-vs-many wording. */
  restaurantCount: number;
}

/**
 * `branches_public_read` only exposes active branches, so a rider whose restaurant was
 * deactivated gets a null embed and their money would otherwise lose its name entirely.
 */
export const UNKNOWN_RESTAURANT_LABEL = 'Restaurant no longer listed';

/**
 * Brand first, shop second — the same order /app/apply uses, so a rider recognises the row
 * from the application they filed. A restaurant that never named its branches collapses to
 * one label rather than repeating itself.
 */
export function restaurantLabel(branch: EarningsBranchRef | null | undefined): {
  restaurantName: string;
  branchName: string;
} {
  if (!branch) return { restaurantName: UNKNOWN_RESTAURANT_LABEL, branchName: '' };
  return {
    restaurantName: branch.restaurant?.name ?? branch.name,
    branchName: branch.name,
  };
}

/** The branch line worth printing under the brand, or null when it would just repeat it. */
export function branchSubtitle(label: {
  restaurantName: string;
  branchName: string;
}): string | null {
  const branch = label.branchName.trim();
  if (!branch || branch === label.restaurantName.trim()) return null;
  return branch;
}

function toAmount(value: number | string | null | undefined): number {
  const n = typeof value === 'string' ? Number(value) : (value ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/** Cents, once, at the end — summing pre-rounded floats is how a total drifts off a receipt. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function emptyAmounts(): EarningsAmounts {
  return {
    available: 0,
    requested: 0,
    paid: 0,
    lifetime: 0,
    deliveries: 0,
    availableDeliveries: 0,
    base: 0,
    distance: 0,
    tip: 0,
  };
}

function roundAmounts(a: EarningsAmounts): EarningsAmounts {
  return {
    available: round2(a.available),
    requested: round2(a.requested),
    paid: round2(a.paid),
    lifetime: round2(a.lifetime),
    deliveries: a.deliveries,
    availableDeliveries: a.availableDeliveries,
    base: round2(a.base),
    distance: round2(a.distance),
    tip: round2(a.tip),
  };
}

function add(target: EarningsAmounts, row: DriverLedgerEntry): void {
  const total = toAmount(row.total);
  if (row.status === 'paid') target.paid += total;
  else if (row.withdrawal_id) target.requested += total;
  else {
    target.available += total;
    target.availableDeliveries += 1;
  }
  target.lifetime += total;
  target.deliveries += 1;
  target.base += toAmount(row.base_pay);
  target.distance += toAmount(row.distance_pay);
  target.tip += toAmount(row.tip_net);
}

/**
 * Fold the rider's earnings ledger into one pile per restaurant plus an all-restaurants
 * total. The restaurants a rider can act on come first: most money waiting to be requested,
 * then biggest earner, then alphabetically so the order is stable between refreshes.
 */
export function summariseDriverEarnings(
  rows: readonly DriverLedgerEntry[],
): DriverEarningsSummary {
  const byBranch = new Map<string, RestaurantEarnings>();
  const totals = emptyAmounts();

  for (const row of rows) {
    let entry = byBranch.get(row.branch_id);
    if (!entry) {
      entry = { branchId: row.branch_id, ...restaurantLabel(row.branch), ...emptyAmounts() };
      byBranch.set(row.branch_id, entry);
    } else if (entry.restaurantName === UNKNOWN_RESTAURANT_LABEL && row.branch) {
      // One readable row is enough to name the pile; a later null embed must not erase it.
      Object.assign(entry, restaurantLabel(row.branch));
    }
    add(entry, row);
    add(totals, row);
  }

  const restaurants = [...byBranch.values()]
    .map((e) => ({ ...e, ...roundAmounts(e) }))
    .sort(
      (a, b) =>
        b.available - a.available ||
        b.lifetime - a.lifetime ||
        a.restaurantName.localeCompare(b.restaurantName),
    );

  return { restaurants, totals: roundAmounts(totals), restaurantCount: restaurants.length };
}
