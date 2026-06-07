import { getServerClient } from '@favornoms/database/server';
import { WaitlistView } from './_components/waitlist-view';

interface Props { params: Promise<{ branchId: string }> }

export const metadata = { title: 'Waitlist · Favornoms admin' };

export default async function WaitlistPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: waitlist } = await supabase
    .from('waitlist')
    .select('id, party_name, party_size, phone, notes, status, position, added_at, notified_at, seated_at')
    .eq('branch_id', branchId)
    .order('added_at', { ascending: false })
    .limit(200);
  return <WaitlistView branchId={branchId} initial={(waitlist ?? []) as never[]} />;
}
