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
