import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';

export type LoyaltyPointsRow = Database['public']['Tables']['loyalty_points']['Row'];
export type LoyaltyTxRow = Database['public']['Tables']['loyalty_transactions']['Row'];
export type LoyaltyTier = Database['public']['Enums']['loyalty_tier'];

/**
 * Get the signed-in customer's loyalty balance at a branch. Honors the
 * restaurant's loyalty_scope ('branch' = per-branch pool, 'brand' = pool
 * shared across branches of the same restaurant).
 */
export async function getMyLoyalty(
  supabase: FavornomsClient,
  branchId: string,
): Promise<{
  points_balance: number;
  lifetime_earned: number;
  lifetime_spent: number;
  tier: string;
  scope: 'branch' | 'brand';
} | null> {
  const { data, error } = await supabase.rpc('get_loyalty_balance', {
    p_branch_id: branchId,
  });
  if (error || !data || data.length === 0) return null;
  const row = data[0] as {
    points_balance: number;
    lifetime_earned: number;
    lifetime_spent: number;
    tier: string;
    scope: 'branch' | 'brand';
  };
  return row;
}

export async function listMyLoyaltyTransactions(
  supabase: FavornomsClient,
  branchId: string,
  limit = 20,
): Promise<LoyaltyTxRow[]> {
  const { data: userData } = await supabase.auth.getUser();
  if (!userData.user) return [];
  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('user_id', userData.user.id)
    .maybeSingle();
  if (!customer) return [];

  const { data } = await supabase
    .from('loyalty_transactions')
    .select('*')
    .eq('branch_id', branchId)
    .eq('customer_id', customer.id)
    .order('created_at', { ascending: false })
    .limit(limit);
  return data ?? [];
}

export async function redeemLoyaltyPoints(
  supabase: FavornomsClient,
  branchId: string,
  points: number,
  orderId?: string,
) {
  const { data, error } = await supabase.rpc('redeem_loyalty_points', {
    p_branch_id: branchId,
    p_points: points,
    p_order_id: orderId ?? undefined,
  });
  if (error) throw new Error(`redeem_failed:${error.message}`);
  return data as { balance: number; redeemed: number };
}
