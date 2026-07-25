import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { CheckoutView } from './_components/checkout-view';
import { SuspendedStorefront } from '../_components/suspended-storefront';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function CheckoutPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={tenant.theme.brandName ?? tenant.restaurant.name} />;
  }
  const base = `/r/${restaurant}/${branch}`;
  return (
    <CheckoutView
      branchId={tenant.branch.id}
      base={base}
      canDeliver={status.delivery}
      canUseCard={status.card_payment}
    />
  );
}
