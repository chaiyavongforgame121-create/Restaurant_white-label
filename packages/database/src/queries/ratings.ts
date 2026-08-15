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
  created_at: string;
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
  error: string | null;
}

const EMPTY: BranchRatingsResult = {
  ratings: [],
  foodAvg: null,
  foodCount: 0,
  deliveryAvg: null,
  deliveryCount: 0,
  total: 0,
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
    .select('id, order_id, food_stars, delivery_stars, comment, created_at')
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

  const ratings: BranchRating[] = rows.map((r) => ({
    id: r.id,
    order_id: r.order_id,
    order_number: numbers.get(r.order_id) ?? null,
    food_stars: r.food_stars,
    delivery_stars: r.delivery_stars,
    comment: r.comment,
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
    error: null,
  };
}
