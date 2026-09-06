import type { FavornomsClient } from '../client-type';

// Merchant-facing reads of public.order_ratings. Customers rate the food and,
// on delivery orders, the driver — the table stores them as two separate
// nullable columns (food_stars / delivery_stars), NOT one "rating" column.

export interface BranchRating {
  id: string;
  order_id: string;
  /** Human-facing order number, resolved from public.orders. */
  order_number: string | null;
  food_stars: number | null;
  delivery_stars: number | null;
  comment: string | null;
  /** Which rider was rated. Null on pickup, dine-in and pre-2026-08-30 rows. */
  driver_id: string | null;
  /** Name resolved from public.drivers; null when the row has no rider or RLS hides them. */
  driver_name: string | null;
  /** The diner's words about the RIDER, kept apart from `comment`, which is about the food. */
  driver_comment: string | null;
  created_at: string;
}

/** One rider's delivery score at this branch, so a merchant can see who is carrying it. */
export interface BranchDriverRating {
  driver_id: string;
  name: string | null;
  /** Average delivery_stars for this rider, rounded to 1dp. */
  avg: number | null;
  /** How many of this rider's deliveries were given stars. */
  count: number;
  /** 5 -> 1 stars; index 0 is one star. */
  distribution: [number, number, number, number, number];
  /** Newest first, only rows where the diner actually wrote about the rider. */
  comments: Array<{
    id: string;
    order_number: string | null;
    stars: number | null;
    comment: string;
    created_at: string;
  }>;
}

export interface BranchRatingsResult {
  ratings: BranchRating[];
  /** Average food rating across rows that have one, rounded to 1dp. */
  foodAvg: number | null;
  foodCount: number;
  /** Average driver rating — delivery orders only. */
  deliveryAvg: number | null;
  deliveryCount: number;
  /** Every rating row, including comment-only rows with no stars. */
  total: number;
  /** Per-rider breakdown, best average first. Empty when nothing is attributed to a rider. */
  drivers: BranchDriverRating[];
  error: string | null;
}

const EMPTY: BranchRatingsResult = {
  ratings: [],
  foodAvg: null,
  foodCount: 0,
  deliveryAvg: null,
  deliveryCount: 0,
  total: 0,
  drivers: [],
  error: null,
};

function avg(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10;
}

/**
 * Ratings for one branch, newest first, with the aggregate a merchant actually
 * asks for ("what's my score?") computed alongside.
 *
 * NOTE: RLS policy `ratings_branch_staff_read` matches on staff_members.branch_id,
 * so a restaurant-wide staff row (branch_id IS NULL) reads zero rows even though
 * the admin layout lets that user in. Errors are returned, not swallowed, so that
 * shows up as a message rather than a silently empty page.
 */
export async function getBranchRatings(
  supabase: FavornomsClient,
  branchId: string,
  limit = 200,
): Promise<BranchRatingsResult> {
  const { data, error } = await supabase
    .from('order_ratings')
    .select('id, order_id, food_stars, delivery_stars, comment, driver_comment, driver_id, created_at')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) return { ...EMPTY, error: `${error.message}${error.code ? ` (${error.code})` : ''}` };
  const rows = data ?? [];
  if (rows.length === 0) return { ...EMPTY };

  // Resolved with a second round-trip rather than a PostgREST embed: order_id is
  // a one-to-one FK, and the embed shape (object vs array) has bitten this repo
  // before. A plain id→order_number map is unambiguous.
  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number')
    .in('id', rows.map((r) => r.order_id));
  const numbers = new Map((orders ?? []).map((o) => [o.id, o.order_number]));

  // Same reasoning as the order numbers: a plain id→name map rather than an embed.
  // A missing name is not an error — a rider the branch can no longer read still has
  // deliveries worth scoring, so the card falls back to the id.
  const driverIds = [...new Set(rows.map((r) => r.driver_id).filter((id): id is string => !!id))];
  const { data: driverRows } = driverIds.length
    ? await supabase.from('drivers').select('id, full_name').in('id', driverIds)
    : { data: [] as Array<{ id: string; full_name: string | null }> };
  const driverNames = new Map((driverRows ?? []).map((d) => [d.id, d.full_name]));

  const ratings: BranchRating[] = rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    order_number: numbers.get(r.order_id) ?? null,
    food_stars: r.food_stars,
    delivery_stars: r.delivery_stars,
    comment: r.comment,
    driver_id: r.driver_id,
    driver_name: r.driver_id ? (driverNames.get(r.driver_id) ?? null) : null,
    driver_comment: r.driver_comment,
    created_at: r.created_at,
  }));

  const food = ratings.map((r) => r.food_stars).filter((n): n is number => typeof n === 'number');
  const delivery = ratings
    .map((r) => r.delivery_stars)
    .filter((n): n is number => typeof n === 'number');

  return {
    ratings,
    foodAvg: avg(food),
    foodCount: food.length,
    deliveryAvg: avg(delivery),
    deliveryCount: delivery.length,
    total: ratings.length,
    drivers: groupByDriver(ratings),
    error: null,
  };
}

/**
 * Roll the rows up per rider. Kept as a pure function so the shape is testable without
 * a database, and exported because the same rows are grouped on more than one screen.
 *
 * A rider appears as soon as anything is attributed to them, even a comment with no
 * stars — "he could not find the door" is worth reading whether or not it came with a
 * rating. Riders with stars sort above riders without, then by average, then by volume,
 * so the list opens on the people actually carrying the branch.
 */
export function groupByDriver(ratings: BranchRating[]): BranchDriverRating[] {
  const byDriver = new Map<string, BranchRating[]>();
  for (const r of ratings) {
    if (!r.driver_id) continue;
    const bucket = byDriver.get(r.driver_id);
    if (bucket) bucket.push(r);
    else byDriver.set(r.driver_id, [r]);
  }

  const out: BranchDriverRating[] = [];
  for (const [driver_id, rows] of byDriver) {
    const stars = rows
      .map((r) => r.delivery_stars)
      .filter((n): n is number => typeof n === 'number' && n >= 1 && n <= 5);
    const distribution: [number, number, number, number, number] = [0, 0, 0, 0, 0];
    for (const s of stars) distribution[Math.round(s) - 1]! += 1;

    out.push({
      driver_id,
      name: rows.find((r) => r.driver_name)?.driver_name ?? null,
      avg: avg(stars),
      count: stars.length,
      distribution,
      comments: rows
        .filter((r) => (r.driver_comment ?? '').trim().length > 0)
        .map((r) => ({
          id: r.id,
          order_number: r.order_number,
          stars: r.delivery_stars,
          comment: r.driver_comment!.trim(),
          created_at: r.created_at,
        })),
    });
  }

  return out.sort(
    (a, b) => Number(b.avg != null) - Number(a.avg != null) || (b.avg ?? 0) - (a.avg ?? 0) || b.count - a.count,
  );
}
