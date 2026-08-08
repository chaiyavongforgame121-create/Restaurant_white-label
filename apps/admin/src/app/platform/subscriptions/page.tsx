import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import {
  isPlatformAdmin,
  listBillingProducts,
  listRestaurantSubscriptions,
} from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../_components/platform-nav';
import { SubscriptionsManager } from './_components/subscriptions-manager';

export const metadata = { title: 'Subscriptions · Favornoms' };

export default async function PlatformSubscriptionsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>;
}) {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/subscriptions');
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  const [{ q }, rows, catalog] = await Promise.all([
    searchParams,
    listRestaurantSubscriptions(supabase),
    listBillingProducts(supabase),
  ]);

  return <SubscriptionsManager rows={rows} catalog={catalog} initialQuery={q ?? ''} />;
}
