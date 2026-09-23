import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import {
  isPlatformAdmin,
  listBillingProducts,
  listBillingRequests,
  listRestaurantSubscriptions,
  type RestaurantSubscriptionRow,
} from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../../_components/platform-nav';
import type { PlatformBranchLite } from '../../_components/platform-billing';
import { RequestsView } from './_components/requests-view';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('platformBilling');
  return { title: t('requests.metaTitle') };
}

interface Props {
  searchParams: Promise<{ status?: string }>;
}

export default async function BillingRequestsPage({ searchParams }: Props) {
  const supabase = await getServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect('/login?next=/platform/subscriptions/requests');
  if (!(await isPlatformAdmin(supabase))) return <PlatformAccessDenied />;

  const { status } = await searchParams;
  // An explicit empty string means "all"; absent means the default queue.
  const filter = status === undefined ? 'pending' : status === '' ? null : status;
  // The current package is loaded next to each request because approving REPLACES
  // it: decide_billing_request deletes every line item the request does not name,
  // and a card that showed only the request let an old Base-only request strip
  // Delivery and AI Suite from a store that was paying for both.
  //
  // Inactive products are included: billing_apply_selection does not check
  // is_active, so an add-on retired from the catalog is still applied and charged
  // on approval, and the diff has to price it the same way.
  const [requests, subscriptions, catalog] = await Promise.all([
    listBillingRequests(supabase, filter),
    listRestaurantSubscriptions(supabase),
    listBillingProducts(supabase, true),
  ]);

  const wanted = new Set(requests.map((r) => r.restaurant_id));
  const packages: Record<string, RestaurantSubscriptionRow> = {};
  for (const row of subscriptions) {
    if (wanted.has(row.restaurant_id)) packages[row.restaurant_id] = row;
  }

  // Delivery is per branch, so a request asks for delivery at particular branches.
  // Without their names the card can only say "delivery × 2", which is exactly the
  // sentence an operator cannot act on. Hidden branches are included: a request may
  // legitimately name one, and leaving it unnamed would read as a deleted branch.
  const branches: Record<string, PlatformBranchLite[]> = {};
  const { data: branchRows } = await supabase
    .from('branches')
    .select('id, restaurant_id, name, is_active')
    .in('restaurant_id', [...wanted])
    .order('created_at', { ascending: true });
  for (const b of branchRows ?? []) {
    (branches[b.restaurant_id] ??= []).push({ id: b.id, name: b.name, isActive: b.is_active });
  }

  return (
    <RequestsView
      requests={requests}
      status={status ?? 'pending'}
      packages={packages}
      branches={branches}
      catalog={catalog}
      nowMs={Date.now()}
    />
  );
}
