import { notFound } from 'next/navigation';
import { Lock } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin } from '@favornoms/database/queries';
import { RewardsManager } from './_components/rewards-manager';
import { LoyaltyProgramCard, type LoyaltyProgramValues } from './_components/loyalty-program-card';

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
  // table and to the programme settings. That helper accepts THREE identities —
  // a platform admin, the account in restaurants.owner_user_id, and an active
  // staff_members row with role 'owner' — and this gate used to check only the
  // first and last, so an owner who holds the restaurant through owner_user_id
  // (a store created or transferred by the platform) saw the sidebar link and
  // then an "Owner access only" card for a save the database would accept. Hiding the sidebar link is not a permission — a manager who types
  // the URL would otherwise reach a full CRUD screen whose saves are refused by
  // RLS, and a denied UPDATE reports as "0 rows changed" rather than an error,
  // so the page would look like it worked and silently keep the old reward.
  const { data: userData } = await supabase.auth.getUser();
  const [platformAdmin, { data: membership }, { data: ownerRow }] = await Promise.all([
    isPlatformAdmin(supabase),
    supabase
      .from('staff_members')
      .select('id')
      .eq('user_id', userData.user?.id ?? '')
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active')
      .eq('role', 'owner')
      .maybeSingle(),
    supabase
      .from('restaurants')
      .select('id')
      .eq('id', branch.restaurant_id)
      .eq('owner_user_id', userData.user?.id ?? '')
      .maybeSingle(),
  ]);

  if (!platformAdmin && !membership && !ownerRow) {
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

  const [rewardsRes, itemsRes, branchesRes, programRes] = await Promise.all([
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
    // The programme the storefront reads, so this screen shows the same numbers the diner sees.
    supabase.rpc('loyalty_program', { p_branch_id: branchId }),
  ]);

  // A failed read must NOT fall back to the platform's numbers: the editor would show 1 / 10k /
  // 30k / 100k as if they were this restaurant's, and the merchant's next save would write those
  // over a programme they never meant to touch. No programme, no editor.
  const program = programRes.error
    ? null
    : (programRes.data as {
        points_per_currency: number | string;
        version?: string;
        tiers?: Array<{ key: string; threshold: number; label?: string; perks?: string[] | null }>;
      } | null);
  const tiers = program?.tiers;
  const tierOf = (key: string) => tiers?.find((t) => t.key === key);
  const rate = Number(program?.points_per_currency);
  const programValues: LoyaltyProgramValues | null =
    program && Array.isArray(tiers) && tiers.length > 0 && Number.isFinite(rate) && rate > 0
      ? {
          version: String(program.version ?? ''),
          pointsPerCurrency: rate,
          silver: Number(tierOf('silver')?.threshold ?? 10000),
          gold: Number(tierOf('gold')?.threshold ?? 30000),
          platinum: Number(tierOf('platinum')?.threshold ?? 100000),
          labels: Object.fromEntries(tiers.map((t) => [t.key, String(t.label ?? '')])),
          perks: Object.fromEntries(
            tiers.map((t) => [t.key, Array.isArray(t.perks) ? t.perks.map(String) : null]),
          ),
        }
      : null;

  return (
    <RewardsManager
      restaurantId={branch.restaurant_id}
      branchId={branchId}
      branchCount={branchesRes.data?.length ?? 1}
      initialRewards={(rewardsRes.data ?? []) as never}
      menuItems={(itemsRes.data ?? []) as never}
      programCard={
        programValues ? (
          <LoyaltyProgramCard restaurantId={branch.restaurant_id} initial={programValues} />
        ) : (
          <Card className="mb-6 p-5">
            <h2 className="font-display text-lg font-semibold">Points &amp; tiers</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              The current programme could not be loaded, so it is not shown here — editing it from
              a blank form would overwrite your real earn rate and tiers. Reload the page to try
              again.
            </p>
          </Card>
        )
      }
    />
  );
}
