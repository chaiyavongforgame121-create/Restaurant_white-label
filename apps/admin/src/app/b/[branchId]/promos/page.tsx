import { getServerClient } from '@favornoms/database/server';
import { PromosManager } from './_components/promos-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function PromosPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const [{ data }, { data: branch }] = await Promise.all([
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
      timezone={branch?.timezone || 'America/New_York'}
      initialPromos={(data ?? []) as never}
    />
  );
}
