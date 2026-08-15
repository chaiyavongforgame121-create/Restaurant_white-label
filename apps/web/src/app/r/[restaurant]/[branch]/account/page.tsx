import { resolveTenant } from '@/lib/tenant';
import { AccountView } from './_components/account-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function AccountPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return (
    <AccountView
      base={base}
      brandName={tenant.restaurant.name}
      branchId={tenant.branch.id}
      // Identity is per restaurant, so the profile read has to be scoped by it —
      // `customers_self` alone only narrows to the caller, not to this tenant.
      restaurantId={tenant.restaurant.id}
    />
  );
}
