import { getServerClient } from '@favornoms/database/server';
import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { CheckoutView } from './_components/checkout-view';
import { OrderTypeGate } from '../_components/order-type-gate';
import { todaysDeliveryWindows } from '@/lib/delivery-windows';
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
  // Sales tax is a branches COLUMN, not a settings key, so resolveTenant does not
  // carry it. Read it here: the summary must show the tax place-order will charge
  // from the first paint, not discover it a round-trip later.
  const supabase = await getServerClient();
  const { data: taxRow } = await supabase
    .from('branches')
    .select('sales_tax_rate')
    .eq('id', tenant.branch.id)
    .maybeSingle();
  const base = `/r/${restaurant}/${branch}`;
  // Deep links reach checkout without passing the menu — same gate, same rules.
  return (
    <>
      <OrderTypeGate
        branchId={tenant.branch.id}
        branchName={tenant.branch.name}
        canDeliver={status.delivery}
        deliveryClosedNow={status.delivery_entitled && !status.delivery_available}
        deliveryWindowsToday={todaysDeliveryWindows(status)}
      />
      <CheckoutView
        branchId={tenant.branch.id}
        restaurantId={tenant.restaurant.id}
        base={base}
        canDeliver={status.delivery}
        canUseCard={status.card_payment}
        // Both money inputs mirror place-order's `?? 0` fallback: a branch with
        // neither configured is charged nothing, so it must be shown nothing.
        salesTaxRate={Number(taxRow?.sales_tax_rate ?? 0)}
        serviceFeePercent={Number(tenant.branch.settings.serviceFeePercent ?? 0)}
      />
    </>
  );
}
