import { getTranslations } from 'next-intl/server';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { RewardsManager } from './_components/rewards-manager';
import { LoyaltyProgramCard, type LoyaltyProgramValues } from './_components/loyalty-program-card';

interface Props { params: Promise<{ branchId: string }> }

export default async function LoyaltyRewardsPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('loyalty');

  // Every branch runs its own programme, so the gate is the branch's loyalty.manage capability —
  // the same one the sidebar shows the link for and the one RLS and set_loyalty_settings check
  // (owner, and an admin of this branch). Hiding the sidebar link is not a permission: a manager
  // who typed the URL would otherwise reach a full CRUD screen whose saves are refused by RLS, and
  // a denied UPDATE reports as "0 rows changed" rather than an error.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/loyalty`);
  if (!can('loyalty.manage')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [rewardsRes, itemsRes, settingsRes, programRes] = await Promise.all([
    // This branch's own catalogue. Another branch of the restaurant keeps its own list.
    supabase
      .from('loyalty_rewards')
      .select('*')
      .eq('branch_id', branchId)
      .order('sort_order', { ascending: true })
      .order('points_cost', { ascending: true }),
    // The free-item picker offers THIS branch's menu; the database refuses an item of any other.
    supabase
      .from('menu_items')
      .select('id, name, price, is_active')
      .eq('branch_id', branchId)
      .order('name', { ascending: true }),
    supabase.from('branches').select('settings').eq('id', branchId).maybeSingle(),
    // The programme the storefront reads, so this screen shows the same numbers the diner sees.
    supabase.rpc('loyalty_program', { p_branch_id: branchId }),
  ]);

  const branchSettings = (settingsRes.data?.settings ?? {}) as Record<string, unknown>;
  const currency = typeof branchSettings.currency === 'string' ? branchSettings.currency : 'USD';

  // A failed read must NOT fall back to the platform's numbers: the editor would show 1 / 10k /
  // 30k / 100k as if they were this branch's, and the merchant's next save would write those
  // over a programme they never meant to touch. No programme, no editor.
  const program = programRes.error
    ? null
    : (programRes.data as {
        points_per_currency: number | string;
        version?: string;
        birthday_points?: number | string;
        tiers?: Array<{ key: string; threshold: number; label?: string; perks?: string[] | null }>;
      } | null);
  const tiers = program?.tiers;
  const tierOf = (key: string) => tiers?.find((t) => t.key === key);
  const rate = Number(program?.points_per_currency);
  const birthday = Number(program?.birthday_points ?? 500);
  const programValues: LoyaltyProgramValues | null =
    program && Array.isArray(tiers) && tiers.length > 0 && Number.isFinite(rate) && rate > 0
      ? {
          version: String(program.version ?? ''),
          pointsPerCurrency: rate,
          silver: Number(tierOf('silver')?.threshold ?? 10000),
          gold: Number(tierOf('gold')?.threshold ?? 30000),
          platinum: Number(tierOf('platinum')?.threshold ?? 100000),
          birthdayPoints: Number.isFinite(birthday) && birthday >= 0 ? birthday : 500,
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
      branchName={branch.name}
      currency={currency}
      initialRewards={(rewardsRes.data ?? []) as never}
      menuItems={(itemsRes.data ?? []) as never}
      programCard={
        programValues ? (
          <LoyaltyProgramCard branchId={branchId} currency={currency} initial={programValues} />
        ) : (
          <Card className="mb-6 p-5">
            <h2 className="font-display text-lg font-semibold">{t('program.title')}</h2>
            <p className="mt-2 text-sm text-muted-foreground">{t('program.loadFailed')}</p>
          </Card>
        )
      }
    />
  );
}
