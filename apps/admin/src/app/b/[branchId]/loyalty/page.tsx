import { notFound } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin } from '@favornoms/database/queries';
import { RewardsManager } from './_components/rewards-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function LoyaltyRewardsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  // Mirrors private.user_owns_restaurant(), which guards every write to this
  // table. Hiding the sidebar link is not a permission — a manager who types
  // the URL would otherwise reach a full CRUD screen whose saves are refused by
  // RLS, and a denied UPDATE reports as "0 rows changed" rather than an error,
  // so the page would look like it worked and silently keep the old reward.
  const { data: userData } = await supabase.auth.getUser();
  const [platformAdmin, { data: membership }] = await Promise.all([
    isPlatformAdmin(supabase),
    supabase
      .from('staff_members')
      .select('id')
      .eq('user_id', userData.user?.id ?? '')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active')
      .eq('role', 'owner')
      .maybeSingle(),
  ]);

  if (!platformAdmin && !membership) {
    return (
      <div className="container max-w-3xl py-8">
        <header className="mb-6 px-2 pl-16 lg:px-0">
          <h1 className="font-display text-3xl font-bold">Loyalty rewards</h1>
        </header>
        <Card className="p-6">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold text-destructive">
            <Lock className="h-5 w-5" /> Owner access only
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A reward listed here can be redeemed at <em>every</em> branch of this restaurant and
            comes out of the restaurant&rsquo;s own margin, so the catalog is limited to the owner.
            Ask them to add or change a reward for you.
          </p>
        </Card>
      </div>
    );
  }

  const [rewardsRes, itemsRes, branchesRes] = await Promise.all([
    // Rewards are restaurant-scoped: one catalog every branch of the restaurant
    // redeems from, matching how loyalty_scope defaults to 'brand'.
    supabase
      .from('loyalty_rewards')
      .select('*')
      .eq('restaurant_id', branch.restaurant_id)
      .order('sort_order', { ascending: true })
      .order('points_cost', { ascending: true }),
    // menu_items are branch-scoped, so the free-item picker offers THIS branch's
    // menu. A reward pointing at an item another branch doesn't carry simply
    // won't be listed there — list_loyalty_rewards filters it out per branch.
    supabase
      .from('menu_items')
      .select('id, name, price, is_active')
      .eq('branch_id', branchId)
      .order('name', { ascending: true }),
    supabase
      .from('branches')
      .select('id')
      .eq('restaurant_id', branch.restaurant_id),
  ]);

  return (
    <RewardsManager
      restaurantId={branch.restaurant_id}
      branchId={branchId}
      branchCount={branchesRes.data?.length ?? 1}
      initialRewards={(rewardsRes.data ?? []) as never}
      menuItems={(itemsRes.data ?? []) as never}
    />
  );
}
