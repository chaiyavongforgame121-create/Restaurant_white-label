import { resolveTenant } from '@/lib/tenant';
import { AddressesView } from './_components/addresses-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function AddressesPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return <AddressesView base={base} branchId={tenant.branch.id} />;
}
