import type { FavornomsClient } from '../client-type';

export interface PlanLimitCheck {
  allowed: boolean;
  limit: number;
  current: number | null;
  plan?: string;
}

export interface PlanStatus {
  plan: string;
  branches: PlanLimitCheck;
  items: PlanLimitCheck;
  orders_per_month: PlanLimitCheck;
}

export async function getPlanStatus(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<PlanStatus | null> {
  const { data, error } = await supabase.rpc('get_my_plan_status', { p_restaurant_id: restaurantId });
  if (error) return null;
  return data as PlanStatus;
}

export function describePlanError(err: unknown): { kind: 'limit'; key: string; current: string; limit: string } | null {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  const m = msg.match(/plan_limit_exceeded:([a-z_]+):(\d+)\/(-?\d+)/);
  if (!m) return null;
  return { kind: 'limit', key: m[1]!, current: m[2]!, limit: m[3]! };
}
