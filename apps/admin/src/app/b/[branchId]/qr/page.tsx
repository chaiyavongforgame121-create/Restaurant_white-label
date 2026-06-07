import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { BranchQr } from './_components/branch-qr';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function BranchQrPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, slug, restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('slug, name')
    .eq('id', branch.restaurant_id)
    .maybeSingle();

  const base = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000').replace(/\/$/, '');
  const url = restaurant?.slug && branch.slug ? `${base}/r/${restaurant.slug}/${branch.slug}` : null;

  return <BranchQr url={url} branchName={branch.name} restaurantName={restaurant?.name ?? ''} />;
}
