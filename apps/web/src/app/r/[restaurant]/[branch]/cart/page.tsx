import { notFound } from 'next/navigation';
import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { CartView } from './_components/cart-view';
import { SuspendedStorefront } from '../_components/suspended-storefront';

interface Props { params: Promise<{ restaurant: string; branch: string }> }

export default async function CartPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  if (!tenant) notFound();
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={tenant.theme.brandName ?? tenant.restaurant.name} />;
  }
  return <CartView />;
}
