import { getServerClient } from '@favornoms/database/server';
import { getBranchReports } from '@favornoms/database/queries';
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
  const [reports, { data: branch }] = await Promise.all([
    getBranchReports(supabase, branchId, daysBack),
    supabase.from('branches').select('timezone').eq('id', branchId).maybeSingle(),
  ]);

  return (
    <ReportsView
      branchId={branchId}
      initialDays={daysBack}
      reports={reports}
      timezone={branch?.timezone ?? 'America/New_York'}
    />
  );
}
