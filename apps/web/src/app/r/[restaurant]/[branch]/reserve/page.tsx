import { resolveStorefrontStatus, resolveTenant } from '@/lib/tenant';
import { ReserveView } from './_components/reserve-view';
import { SuspendedStorefront } from '../_components/suspended-storefront';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function ReservePage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const status = await resolveStorefrontStatus(tenant.branch.id);
  if (!status.entitled) {
    return <SuspendedStorefront brandName={tenant.theme.brandName ?? tenant.restaurant.name} />;
  }
  const base = `/r/${restaurant}/${branch}`;
  return (
    <ReserveView
      base={base}
      branchId={tenant.branch.id}
      branchName={tenant.branch.name}
    />
  );
}
