import { redirect } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { isPlatformAdmin, listBillingRequests } from '@favornoms/database/queries';
import { PlatformAccessDenied } from '../../_components/platform-nav';
import { RequestsView } from './_components/requests-view';

export const metadata = { title: 'Package requests · Favornoms' };

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
  const requests = await listBillingRequests(supabase, filter);

  return <RequestsView requests={requests} status={status ?? 'pending'} />;
}
