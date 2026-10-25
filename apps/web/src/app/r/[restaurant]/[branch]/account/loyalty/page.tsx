import { storefrontBase } from '@favornoms/database/storefront-path';
import { resolveTenant, storefrontNames } from '@/lib/tenant';
import { LoyaltyView } from './_components/loyalty-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function LoyaltyPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = storefrontBase(tenant);
  return <LoyaltyView base={base} brandName={storefrontNames(tenant).full} branchId={tenant.branch.id} />;
}
