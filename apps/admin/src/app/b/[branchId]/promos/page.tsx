import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { PromosManager } from './_components/promos-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function PromosPage({ params }: Props) {
  const { branchId } = await params;
  // Creating codes is promos.manage. A cashier applies them at the till (promos.apply) and
  // never edits them here.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/promos`);
  if (!can('promos.manage')) return <PageAccessDenied area="promos" branchName={branch.name} />;
  const [{ data }, { data: detail }] = await Promise.all([
    supabase
      .from('promos')
      .select('*')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false }),
    supabase.from('branches').select('timezone').eq('id', branchId).maybeSingle(),
  ]);
  return (
    <PromosManager
      branchId={branchId}
      // The same fallback is_branch_open() uses for a branch with no zone recorded.
      timezone={detail?.timezone || 'America/New_York'}
      initialPromos={(data ?? []) as never}
    />
  );
}
