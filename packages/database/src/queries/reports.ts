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

export async function getBranchReports(
  supabase: FavornomsClient,
  branchId: string,
  days = 7,
): Promise<BranchReports | null> {
  const { data, error } = await supabase.rpc('get_branch_reports', {
    p_branch_id: branchId,
    p_days: days,
  });
  if (error || !data) return null;
  return data as unknown as BranchReports;
}
