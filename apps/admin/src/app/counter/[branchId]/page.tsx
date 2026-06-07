import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { listCategories, listMenuItems } from '@favornoms/database/queries';
import { CounterView } from './_components/counter-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function CounterPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const [categories, items] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
  ]);
  return <CounterView branchId={branchId} branchName={branch.name} categories={categories} items={items} />;
}
