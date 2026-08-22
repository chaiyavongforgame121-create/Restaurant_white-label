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
  // Scope-aware (brand vs branch) + restaurant-level customer resolution lives in the
  // RPC, so history follows the restaurant's loyalty_scope instead of one branch.
  const { data, error } = await supabase.rpc('list_my_loyalty_transactions', {
    p_branch_id: branchId,
    p_limit: limit,
  });
  if (error) return [];
  return (data ?? []) as LoyaltyTxRow[];
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

export type LoyaltyRewardRow = Database['public']['Tables']['loyalty_rewards']['Row'];
export type LoyaltyRewardKind = 'percent_off' | 'fixed_off' | 'free_item' | 'free_delivery';

/** One redeemable reward as the diner sees it, with the free item resolved. */
export interface LoyaltyReward {
  id: string;
  name: string;
  description: string | null;
  kind: LoyaltyRewardKind;
  points_cost: number;
  value: number;
  max_discount: number | null;
  min_subtotal: number;
  menu_item_id: string | null;
  menu_item_name: string | null;
  menu_item_image_url: string | null;
  menu_item_price: number | null;
}

/**
 * The merchant's reward catalog for one branch.
 *
 * Goes through the RPC rather than selecting `loyalty_rewards` directly: the
 * table has no public read policy, so paused rewards stay private, and the RPC
 * also drops free-item rewards whose menu item does not exist at THIS branch
 * (menu_items are branch-scoped while the catalog is restaurant-scoped).
 */
export async function listLoyaltyRewards(
  supabase: FavornomsClient,
  branchId: string,
): Promise<LoyaltyReward[]> {
  const { data, error } = await supabase.rpc('list_loyalty_rewards', {
    p_branch_id: branchId,
  });
  if (error) return [];
  return (data ?? []) as LoyaltyReward[];
}

/**
 * What a reward takes off this order, in dollars.
 *
 * Mirrors the same switch in supabase/functions/place-order. The server is
 * authoritative — this exists so the checkout summary shows the number the
 * server will actually charge instead of one the diner has to discover is wrong
 * on the receipt. `free_delivery` returns 0 because it zeroes the delivery fee
 * rather than discounting the food.
 */
export function loyaltyRewardDiscount(
  reward: Pick<LoyaltyReward, 'kind' | 'value' | 'max_discount' | 'menu_item_price'>,
  subtotal: number,
): number {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  switch (reward.kind) {
    case 'percent_off': {
      const off = (subtotal * Number(reward.value)) / 100;
      return r2(
        reward.max_discount != null ? Math.min(off, Number(reward.max_discount)) : off,
      );
    }
    case 'fixed_off':
      return r2(Math.min(Number(reward.value), subtotal));
    case 'free_item':
      return r2(Math.min(Number(reward.menu_item_price ?? 0), subtotal));
    default:
      return 0;
  }
}
