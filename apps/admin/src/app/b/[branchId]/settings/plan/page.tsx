import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { PlanView } from './_components/plan-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Plan & billing · Favornoms' };

export default async function PlanPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('restaurant_id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch?.restaurant_id) notFound();

  const [{ data: plans }, planStatus] = await Promise.all([
    supabase.from('subscription_plans').select('code, name, monthly_price, limits').eq('is_active', true).order('monthly_price'),
    supabase.rpc('get_my_plan_status', { p_restaurant_id: branch.restaurant_id }),
  ]);

  return (
    <PlanView
      branchId={branchId}
      restaurantId={branch.restaurant_id}
      plans={(plans ?? []) as never[]}
      status={planStatus.data as never}
    />
  );
}
