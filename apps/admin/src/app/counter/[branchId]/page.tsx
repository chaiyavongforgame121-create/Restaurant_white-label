import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getEntitlementsForBranch, listCategories, listMenuItems } from '@favornoms/database/queries';
import { hasFeature, parseServiceFeePercent } from '@favornoms/shared';
import { SuspensionScreen } from '@/components/suspension-screen';
import { CounterView } from './_components/counter-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function CounterPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  // sales_tax_rate and settings ride along because the till has to price the cart the way
  // place-order will. Without them the Charge button quoted the food alone while the server
  // charged tax and the card fee on top, and the drawer came up short by the difference.
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, sales_tax_rate, settings')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const settings = (branch.settings ?? {}) as Record<string, unknown>;
  const [categories, items, entitlements] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
    getEntitlementsForBranch(supabase, branchId),
  ]);
  // Gate the till at the page, not the layout: /counter/[branchId]/recent must
  // stay reachable while suspended so staff can look up and reprint an order
  // that was already taken. Without the gate a cashier would ring a whole sale
  // and only hit the BEFORE INSERT trigger at "Charge", in front of a customer.
  if (!entitlements.entitled) {
    return <SuspensionScreen branchId={branchId} branchName={branch.name} surface="The counter" />;
  }

  return (
    <CounterView
      branchId={branchId}
      branchName={branch.name}
      categories={categories}
      items={items}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      canDeliver={hasFeature(entitlements, 'delivery')}
      salesTaxRate={Number(branch.sales_tax_rate ?? 0)}
      serviceFeePercent={parseServiceFeePercent(settings)}
      // place-order's own fallback when a delivery order carries no coordinates.
      deliveryFeeFlat={Number(settings.delivery_fee ?? 3.99)}
    />
  );
}
