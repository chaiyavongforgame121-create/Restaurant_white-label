import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getRestaurantReportsResult } from '@favornoms/database/queries';
import { HqView } from './_components/hq-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ months?: string }>;
}

export default async function HqPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { months } = await searchParams;
  // The RPC clamps to [1,24] as well; clamping here too keeps the switcher and
  // the heading from advertising a range the data doesn't actually cover.
  const monthsBack = Math.max(1, Math.min(24, Number(months) || 6));

  const supabase = await getServerClient();
  // Sequential for the same reason as /reports: two calls racing one token
  // refresh means the loser comes back as `anon`, which has no EXECUTE here.
  const { data: branch } = await supabase
    .from('branches')
    .select('restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  let { data: reports, error } = await getRestaurantReportsResult(
    supabase,
    branch.restaurant_id,
    monthsBack,
  );
  // Retry transient failures only. 42501 is the owner-only guard firing on
  // purpose — asking again just denies the same manager a second time.
  if (error && !error.includes('42501')) {
    ({ data: reports, error } = await getRestaurantReportsResult(
      supabase,
      branch.restaurant_id,
      monthsBack,
    ));
  }

  return (
    <HqView branchId={branchId} initialMonths={monthsBack} reports={reports} error={error} />
  );
}
