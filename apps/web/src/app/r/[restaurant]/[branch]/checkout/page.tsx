import { resolveTenant } from '@/lib/tenant';
import { CheckoutView } from './_components/checkout-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function CheckoutPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return <CheckoutView branchId={tenant.branch.id} base={base} />;
}
