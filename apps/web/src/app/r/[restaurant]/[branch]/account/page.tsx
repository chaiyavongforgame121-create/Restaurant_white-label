import { resolveTenant, storefrontNames } from '@/lib/tenant';
import { AccountView } from './_components/account-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function AccountPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = `/r/${restaurant}/${branch}`;
  return (
    <AccountView
      base={base}
      brandName={storefrontNames(tenant).full}
      // The diner's record is per branch, so the profile read is scoped by it —
      // `customers_self_read` alone only narrows to the caller, not to this branch.
      branchId={tenant.branch.id}
    />
  );
}
