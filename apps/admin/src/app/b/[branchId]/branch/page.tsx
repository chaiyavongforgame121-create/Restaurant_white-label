import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { BranchSettings } from './_components/branch-settings';

interface Props { params: Promise<{ branchId: string }> }

export default async function BranchPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  return <BranchSettings branch={branch as never} />;
}
