import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin, listBillingProducts } from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { PlansManager } from './_components/plans-manager';

export const metadata = { title: 'Product catalog · Favornoms' };

export default async function PlatformPlansPage() {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/plans');

  // Server-side gate. The sidebar is cosmetic; this is the one that holds.
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  // Inactive rows included — deactivated legacy products must stay editable.
  const products = await listBillingProducts(supabase, true);

  return <PlansManager products={products} />;
}
