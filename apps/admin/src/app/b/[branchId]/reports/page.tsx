import { getServerClient } from '@favornoms/database/server';
import { getBranchReportsResult } from '@favornoms/database/queries';
import { ReportsView } from './_components/reports-view';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ days?: string }>;
}

export default async function ReportsPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { days } = await searchParams;
  const daysBack = Math.max(1, Math.min(90, Number(days) || 7));

  const supabase = await getServerClient();
  // Sequential, not Promise.all: firing two calls at once on a freshly-expired
  // access token makes them race the same refresh, and the loser comes back as
  // `anon` — which has no EXECUTE on get_branch_reports, so the page rendered
  // "No data" for what is really an auth blip. The cheap branch read goes first
  // and settles the token for the RPC that follows.
  const { data: branch } = await supabase
    .from('branches')
    .select('timezone')
    .eq('id', branchId)
    .maybeSingle();

  let { data: reports, error } = await getBranchReportsResult(supabase, branchId, daysBack);
  if (error) {
    // One retry — transient 401/503s from a token refresh or a cold PostgREST
    // should not cost the merchant their reports.
    ({ data: reports, error } = await getBranchReportsResult(supabase, branchId, daysBack));
  }

  return (
    <ReportsView
      branchId={branchId}
      initialDays={daysBack}
      reports={reports}
      error={error}
      timezone={branch?.timezone ?? 'America/New_York'}
    />
  );
}
