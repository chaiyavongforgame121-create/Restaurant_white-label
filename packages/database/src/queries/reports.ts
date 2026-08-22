import type { FavornomsClient } from '../client-type';

export interface BranchReports {
  period_days: number;
  since: string;
  totals: {
    orders: number;
    revenue: number;
    avg_order_value: number;
    completed_orders: number;
  };
  daily: { day: string; orders: number; revenue: number }[];
  by_channel: { channel: string; orders: number; revenue: number }[];
  by_status: { status: string; orders: number }[];
  hour_heatmap: { dow: string; hour: number; orders: number; revenue: number }[];
  top_items: { name: string; quantity: number; revenue: number }[];
  by_category: { category: string | null; quantity: number; revenue: number }[];
}

export interface BranchReportsResult {
  data: BranchReports | null;
  /** Human-readable failure, already including the Postgres code/hint when present.
   *  null when the RPC succeeded (even if the branch simply has no orders). */
  error: string | null;
}

/**
 * get_branch_reports(p_branch_id uuid, p_days integer) — arg names must match the
 * SQL signature exactly or PostgREST answers PGRST202 (function not found).
 *
 * Unlike getBranchReports() this never collapses a failure into `null`: a merchant
 * staring at "No data" cannot tell a broken session from an empty week, so the
 * caller gets the real error text to render.
 */
export async function getBranchReportsResult(
  supabase: FavornomsClient,
  branchId: string,
  days = 7,
): Promise<BranchReportsResult> {
  const { data, error } = await supabase.rpc('get_branch_reports', {
    p_branch_id: branchId,
    p_days: days,
  });
  if (error) {
    const parts = [error.message, error.hint, error.details].filter(Boolean);
    return { data: null, error: `${parts.join(' — ')}${error.code ? ` (${error.code})` : ''}` };
  }
  if (!data) return { data: null, error: 'The reports service returned an empty response.' };
  return { data: data as unknown as BranchReports, error: null };
}

export async function getBranchReports(
  supabase: FavornomsClient,
  branchId: string,
  days = 7,
): Promise<BranchReports | null> {
  const { data } = await getBranchReportsResult(supabase, branchId, days);
  return data;
}

/** Head-office rollup: every branch of one restaurant, by month. */
export interface RestaurantReports {
  restaurant_id: string;
  restaurant_name: string;
  period_months: number;
  since: string;
  /** Head-office clock — the oldest branch's timezone, since months have to be
   *  bucketed in *some* zone and branches may straddle several. */
  timezone: string;
  branch_count: number;
  /** The plan's current monthly charge. Not history — see has_invoices. */
  subscription_monthly: number;
  subscription_plan: string | null;
  /** false when the invoices table is empty for this restaurant, which is the
   *  normal state while Stripe is dormant. The UI must then label the
   *  subscription figure as the *current rate*, not as billed history. */
  has_invoices: boolean;
  totals: {
    orders: number;
    revenue: number;
    avg_order_value: number;
    completed_orders: number;
    driver_payouts: number;
    subscription_billed: number;
  };
  monthly: {
    month: string;
    orders: number;
    revenue: number;
    driver_payouts: number;
    subscription: number;
  }[];
  /** Sorted by revenue, highest first. */
  branches: {
    branch_id: string;
    name: string;
    is_active: boolean;
    orders: number;
    revenue: number;
    completed_orders: number;
    avg_order_value: number;
    driver_payouts: number;
  }[];
  branch_monthly: { branch_id: string; month: string; revenue: number; orders: number }[];
  by_channel: { channel: string; orders: number; revenue: number }[];
}

export interface RestaurantReportsResult {
  data: RestaurantReports | null;
  error: string | null;
}

/**
 * get_restaurant_reports(p_restaurant_id uuid, p_months integer).
 *
 * The RPC *raises* 42501 for a caller who isn't the restaurant owner rather than
 * returning an empty rollup, so "no data" and "not allowed" stay distinguishable
 * — hence the error text is carried through instead of collapsed to null.
 */
export async function getRestaurantReportsResult(
  supabase: FavornomsClient,
  restaurantId: string,
  months = 6,
): Promise<RestaurantReportsResult> {
  const { data, error } = await supabase.rpc('get_restaurant_reports', {
    p_restaurant_id: restaurantId,
    p_months: months,
  });
  if (error) {
    const parts = [error.message, error.hint, error.details].filter(Boolean);
    return { data: null, error: `${parts.join(' — ')}${error.code ? ` (${error.code})` : ''}` };
  }
  if (!data) return { data: null, error: 'The reports service returned an empty response.' };
  return { data: data as unknown as RestaurantReports, error: null };
}
