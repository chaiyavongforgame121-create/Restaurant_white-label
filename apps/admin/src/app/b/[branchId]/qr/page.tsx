import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { storefrontBase } from '@/lib/site-url';
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

  // A branch custom domain is rewritten straight to this branch's menu by the
  // customer-app middleware (resolve_custom_domain), so its root IS the menu.
  const domain = branch.custom_domain?.trim().toLowerCase();
  const missing: string[] = [];
  if (!branch.slug) missing.push('branch');
  if (!restaurant?.slug) missing.push('restaurant');

  const url = domain
    ? `https://${domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}`
    : missing.length === 0
      ? `${storefrontBase()}/r/${restaurant!.slug}/${branch.slug}`
      : null;

  return (
    <BranchQr
      url={url}
      branchId={branchId}
      branchName={branch.name}
      restaurantName={restaurant?.name ?? ''}
      missingSlugs={missing}
    />
  );
}
