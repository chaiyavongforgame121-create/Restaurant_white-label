import { getRestaurantReportsResult } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
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

  // Only the sidebar and get_restaurant_reports' own 42501 kept this owner screen closed, so
  // anyone else got the head-office chrome around an error card. hq.view is what both ask.
  // Sequential for the same reason as /reports: two calls racing one token refresh means the
  // loser comes back as `anon`, which has no EXECUTE here.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/hq`);
  if (!can('hq.view')) return <PageAccessDenied area="hq" branchName={branch.name} />;

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
  // The card shows a translated sentence, never this text, so the server log is where support
  // finds out what actually failed.
  if (error && !error.includes('42501')) {
    console.error('[hq] get_restaurant_reports failed after a retry', {
      branchId,
      restaurantId: branch.restaurant_id,
      monthsBack,
      error,
    });
  }

  return (
    <HqView branchId={branchId} initialMonths={monthsBack} reports={reports} error={error} />
  );
}
