import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { ReportsView } from './_components/reports-view';
import { getReportSections } from './_components/report-queries';
import { localDay, parseReportRange } from './_components/report-range';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{ range?: string; from?: string; to?: string; days?: string }>;
}

export default async function ReportsPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const sp = await searchParams;

  // The sidebar has always hidden Reports without reports.view, but the URL is guessable
  // and get_branch_reports only ever gated on branch membership — so a cook or cashier who
  // typed it in got the whole sales picture. The six section RPCs gate on the capability;
  // this check is what turns that into a card instead of a raw 42501.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/reports`);
  if (!can('reports.view')) {
    return (
      <AccessDenied
        title="No reports access"
        reason={`Only owners, admins and managers can see sales reports at ${branch.name}.`}
      />
    );
  }

  // getBranchAccess reads only id/name/restaurant_id. Reports needs the branch's clock, so
  // a day means the merchant's day, and the currency it actually charges in.
  const { data: detail } = await supabase
    .from('branches')
    .select('timezone, settings')
    .eq('id', branchId)
    .maybeSingle();
  const timezone = detail?.timezone ?? 'America/New_York';
  const settings = (detail?.settings ?? {}) as Record<string, unknown>;
  const currency = typeof settings.currency === 'string' ? settings.currency : 'USD';

  const now = new Date();
  const range = parseReportRange(sp, timezone, now);
  const sections = await getReportSections(supabase, branchId, range);

  return (
    <ReportsView
      branchId={branchId}
      timezone={timezone}
      currency={currency}
      range={range}
      today={localDay(now, timezone)}
      sections={sections}
    />
  );
}
