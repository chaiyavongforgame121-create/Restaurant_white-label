import { getServerClient } from '@favornoms/database/server';
import { BroadcastsPanel } from './_components/broadcasts-panel';

interface Props { params: Promise<{ branchId: string }> }

export default async function MarketingPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: broadcasts } = await supabase
    .from('broadcasts')
    .select('id, title, body, url, status, recipient_count, sent_at, scheduled_for, audience, channels, created_at')
    .eq('branch_id', branchId)
    .order('created_at', { ascending: false })
    .limit(50);

  return <BroadcastsPanel branchId={branchId} initialBroadcasts={broadcasts ?? []} />;
}
