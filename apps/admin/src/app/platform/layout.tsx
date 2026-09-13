import { getServerClient } from '@favornoms/database/server';
import { listBillingRequests } from '@favornoms/database/queries';
import { PendingRequestsProvider } from './_components/pending-requests';

// A layout, not a per-page read: it renders once for every /platform route, and
// router.refresh() re-renders it too — which is what the requests page calls after
// Approve or Reject, so the badge drops the moment a decision lands.
export default async function PlatformLayout({ children }: { children: React.ReactNode }) {
  const supabase = await getServerClient();
  // list_billing_requests raises for anyone who is not a platform admin and the
  // helper resolves that to [], so a signed-out or denied visitor gets no badge
  // and each page still decides access on its own.
  const pending = await listBillingRequests(supabase, 'pending');
  return <PendingRequestsProvider count={pending.length}>{children}</PendingRequestsProvider>;
}
