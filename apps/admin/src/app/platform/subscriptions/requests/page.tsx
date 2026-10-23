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
  // it: decide_billing_request rewrites the line items to the request's plan and seat
  // count and restarts the month, so a card that showed only the request could not
  // say that approving takes branch seats away or shortens what is already paid for.
  //
  // Inactive products are read too, but only so a request naming a withdrawn product
  // still shows its name. Nothing withdrawn is ever priced: the card prices from the
  // active products alone (sellableCatalog), so the withdrawn Delivery row can never
  // add money to a total.
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

  return (
    <RequestsView
      requests={requests}
      status={status ?? 'pending'}
      packages={packages}
      catalog={catalog}
      nowMs={Date.now()}
      // The platform switch rides on every row's `billing` (it is one setting), so any
      // row answers it; with no restaurants at all there is nothing to settle either way.
      // With the switch off, a restaurant already paying by card still changes its package
      // by card (the switch stops NEW card purchases only), so its requests settle too.
      cardPayments={subscriptions.some((row) => row.billing.stripeEnabled || row.billing.rail === 'stripe')}
      // The switch itself, read the same way (any readable row answers it). Off, a Checkout the
      // merchant already opened is not closed: it stays "Awaiting card payment" until they pay
      // it or send the request to the team from their plan page. No rows: unknown, not off.
      cardSwitchOn={subscriptions.length > 0 ? subscriptions.some((row) => row.billing.stripeEnabled) : null}
    />
  );
}
