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
/** One rung of the ladder, in this restaurant's own words. */
export interface LoyaltyProgramTier {
  key: string;
  threshold: number;
  /** What the merchant calls this rung, or the platform's name when they haven't renamed it. */
  label: string;
  /**
   * The merchant's own benefit lines. `null` means they never wrote any and the caller should show
   * DEFAULT_TIER_PERKS; an empty array means they deliberately say nothing beyond the threshold.
   * The "unlocked at N points" line is never stored here — it is drawn from `threshold`, so moving
   * a tier can never leave a stale number in the copy.
   */
  perks: string[] | null;
}

/** The merchant's own programme: what a currency unit earns, and the tier ladder. */
export interface LoyaltyProgram {
  /** Hash of the stored settings. An editor sends back the one it loaded, so a stale tab cannot
   *  overwrite a newer save. */
  version: string;
  pointsPerCurrency: number;
  tiers: LoyaltyProgramTier[];
  scope: 'branch' | 'brand';
}

/** What each tier says until the merchant writes their own line. Shared so the admin screen can
 *  show the merchant the copy they are about to replace. */
export const DEFAULT_TIER_PERKS: Record<string, string[]> = {
  bronze: ['Spend your points on any reward the restaurant is offering.'],
  // Deliberately name-free: a restaurant can rename every rung and leave these lines as they are,
  // and a sheet titled with its own name must not go on to talk about "Silver" or "Gold".
  silver: ['A member badge on your account, so the restaurant can send you member-only offers.'],
  gold: [
    'Member-only promotions and early access to campaigns the restaurant runs for its best regulars.',
  ],
  platinum: ['The top tier — the restaurant’s most exclusive offers land here first.'],
};

/** Platform defaults — what every restaurant had before the settings existed. */
export const DEFAULT_LOYALTY_PROGRAM: LoyaltyProgram = {
  version: '',
  pointsPerCurrency: 1,
  tiers: [
    { key: 'bronze', threshold: 0, label: 'Bronze', perks: null },
    { key: 'silver', threshold: 10000, label: 'Silver', perks: null },
    { key: 'gold', threshold: 30000, label: 'Gold', perks: null },
    { key: 'platinum', threshold: 100000, label: 'Platinum', perks: null },
  ],
  scope: 'brand',
};

const FALLBACK_LABEL: Record<string, string> = Object.fromEntries(
  DEFAULT_LOYALTY_PROGRAM.tiers.map((t) => [t.key, t.label]),
);

/**
 * Readable by anyone who can see the storefront: the customer page states the rate, draws the
 * ladder and names each rung, so all three have to be the merchant's own rather than a copy in the
 * client.
 *
 * Returns null when the read fails. It used to return DEFAULT_LOYALTY_PROGRAM instead, which made a
 * failure indistinguishable from a restaurant on the platform's numbers: the customer page drew the
 * platform ladder and told a Platinum member they were Bronze. Callers that only want names can
 * fall back to DEFAULT_LOYALTY_PROGRAM themselves; callers that state numbers must not.
 */
export async function getLoyaltyProgram(
  supabase: FavornomsClient,
  branchId: string,
): Promise<LoyaltyProgram | null> {
  const { data, error } = await supabase.rpc('loyalty_program', { p_branch_id: branchId });
  if (error || !data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const rate = Number(d.points_per_currency);
  const tiers = Array.isArray(d.tiers)
    ? (d.tiers as Array<Record<string, unknown>>)
        .map((t) => {
          const key = String(t.key ?? '');
          return {
            key,
            threshold: Number(t.threshold),
            label: String(t.label ?? '').trim() || FALLBACK_LABEL[key] || key,
            // Only an array counts as "the merchant has written these"; anything else, including
            // the json null the function returns for an untouched tier, means "use the stock line".
            perks: Array.isArray(t.perks)
              ? (t.perks as unknown[]).map((p) => String(p)).filter(Boolean)
              : null,
          };
        })
        .filter((t) => t.key && Number.isFinite(t.threshold))
    : [];
  if (!tiers.length || !Number.isFinite(rate) || rate <= 0) return null;
  return {
    version: typeof d.version === 'string' ? d.version : '',
    pointsPerCurrency: rate,
    tiers,
    scope: d.scope === 'branch' ? 'branch' : 'brand',
  };
}