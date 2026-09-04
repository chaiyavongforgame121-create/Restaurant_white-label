import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { branchMenuLink } from './_lib/menu-url';
import { BranchQr } from './_components/branch-qr';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function BranchQrPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, slug, custom_domain, restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('slug, name')
    .eq('id', branch.restaurant_id)
    .maybeSingle();

  const { url, missingSlugs } = branchMenuLink(branch.slug, restaurant?.slug, branch.custom_domain);

  // Whether this branch has any table codes decides how the page describes itself: with
  // tables set up, this code is the counter/takeaway one and the table tents are elsewhere.
  const { count: tableCount } = await supabase
    .from('tables')
    .select('id', { count: 'exact', head: true })
    .eq('branch_id', branchId)
    .eq('is_active', true);

  return (
    <BranchQr
      url={url}
      branchId={branchId}
      branchName={branch.name}
      restaurantName={restaurant?.name ?? ''}
      missingSlugs={missingSlugs}
      tableCount={tableCount ?? 0}
    />
  );
}
