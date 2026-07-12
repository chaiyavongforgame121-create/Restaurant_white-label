import { notFound } from 'next/navigation';
import { resolveTenant } from '@/lib/tenant';
import { CartView } from './_components/cart-view';

interface Props { params: Promise<{ restaurant: string; branch: string }> }

export default async function CartPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  if (!tenant) notFound();
  return <CartView />;
}
