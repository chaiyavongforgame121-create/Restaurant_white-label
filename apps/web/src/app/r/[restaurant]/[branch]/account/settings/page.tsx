import { storefrontBase } from '@favornoms/database/storefront-path';
import { resolveTenant } from '@/lib/tenant';
import { SettingsView } from './_components/settings-view';

interface Props {
  params: Promise<{ restaurant: string; branch: string }>;
}

export default async function SettingsPage({ params }: Props) {
  const { restaurant, branch } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const base = storefrontBase(tenant);
  return <SettingsView base={base} branchId={tenant.branch.id} />;
}
