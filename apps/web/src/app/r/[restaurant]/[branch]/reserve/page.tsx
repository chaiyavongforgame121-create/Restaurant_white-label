import { resolveTenant } from '@/lib/tenant';
import { ReserveView } from './_components/reserve-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function ReservePage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return (
    <ReserveView
      base={base}
      branchId={tenant.branch.id}
      branchName={tenant.branch.name}
    />
  );
}
