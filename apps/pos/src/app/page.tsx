import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';

export default async function RootPage() {
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id')
    .eq('is_active', true)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (branch?.id) redirect(`/b/${branch.id}`);
  redirect('/setup');
}
