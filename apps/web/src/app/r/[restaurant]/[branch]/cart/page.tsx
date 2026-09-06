import { notFound } from 'next/navigation';
import { resolveStorefrontStatus, resolveStorefrontVersion, resolveTenant } from '@/lib/tenant';
import { CartView } from './_components/cart-view';
import { OrderTypeGate } from '../_components/order-type-gate';
import { todaysDeliveryWindows } from '@/lib/delivery-windows';
import { SuspendedStorefront } from '../_components/suspended-storefront';
import { TablePinNotice } from '../_components/table-pin';

interface Props { params: Promise<{ restaurant: string; branch: string }> }

export default async function CartPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  if (!tenant) notFound();
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={tenant.theme.brandName ?? tenant.restaurant.name} />;
  }
  // Passed down so the cart re-checks its prices whenever the storefront changes, not only
  // when it is first opened. Free here — resolveTenant already read it this render.
  const version = await resolveStorefrontVersion(restaurant, branch);
  // /cart is directly linkable, so the order-type gate has to stand here too.
  return (
    <>
      <OrderTypeGate
        branchId={tenant.branch.id}
        branchName={tenant.branch.name}
        canDeliver={status.delivery}
        deliveryClosedNow={status.delivery_entitled && !status.delivery_available}
        deliveryWindowsToday={todaysDeliveryWindows(status)}
      />
      <TablePinNotice />
      <CartView branchId={tenant.branch.id} storefrontVersion={version.version} />
    </>
  );
}
