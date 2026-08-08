import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { CheckoutView } from './_components/checkout-view';
import { OrderTypeGate } from '../_components/order-type-gate';
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
  // Deep links reach checkout without passing the menu — same gate, same rules.
  return (
    <>
      <OrderTypeGate
        branchId={tenant.branch.id}
        branchName={tenant.branch.name}
        canDeliver={status.delivery}
      />
      <CheckoutView
        branchId={tenant.branch.id}
        base={base}
        canDeliver={status.delivery}
        canUseCard={status.card_payment}
      />
    </>
  );
}
