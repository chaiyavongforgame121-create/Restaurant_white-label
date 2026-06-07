import { getServerClient } from '@favornoms/database/server';
import { PromosManager } from './_components/promos-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function PromosPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data } = await supabase
    .from('promos')
    .select('*')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false });
  return <PromosManager branchId={branchId} initialPromos={(data ?? []) as never} />;
}
