import { resolveTenant } from '@/lib/tenant';
import { LoyaltyView } from './_components/loyalty-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function LoyaltyPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return <LoyaltyView base={base} brandName={tenant.restaurant.name} branchId={tenant.branch.id} />;
}
