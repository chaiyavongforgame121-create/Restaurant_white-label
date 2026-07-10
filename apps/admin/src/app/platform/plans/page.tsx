import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { PlansManager, type PlanRow } from './_components/plans-manager';

export default async function PlatformPlansPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/plans');

  // Gate: get_platform_settings self-gates to platform admins.
  const { error: gateErr } = await supabase.rpc('get_platform_settings');
  if (gateErr) return <PlatformAccessDenied />;

  const { data: plans } = await supabase
    .from('subscription_plans')
    .select('code, name, monthly_price, limits, is_active')
    .order('monthly_price', { ascending: true });

  return <PlansManager plans={(plans ?? []) as PlanRow[]} />;
}
