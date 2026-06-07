import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { PlatformDashboard } from './_components/platform-dashboard';

export default async function PlatformPage() {
  const supabase = await getServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform');

  // Try to fetch ops summary — if it errors with not_platform_admin, redirect
  const { data: summary, error } = await supabase.rpc('platform_ops_summary');
  if (error) {
    return (
      <div className="grid min-h-dynamic-screen place-items-center p-8 text-center">
        <div>
          <h1 className="font-display text-3xl font-bold">Access denied</h1>
          <p className="mt-2 text-muted-foreground">Platform admin only.</p>
        </div>
      </div>
    );
  }

  const { data: restaurants } = await supabase
    .from('restaurants')
    .select('id, slug, name, created_at, franchise_group_id, loyalty_scope')
    .order('created_at', { ascending: false })
    .limit(200);

  const { data: branches } = await supabase
    .from('branches')
    .select('id, restaurant_id, name, is_active')
    .limit(2000);

  return (
    <PlatformDashboard
      summary={summary as Record<string, number>}
      restaurants={(restaurants ?? []) as never}
      branches={(branches ?? []) as never}
    />
  );
}
