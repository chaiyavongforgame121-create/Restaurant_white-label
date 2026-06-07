import { getServerClient } from '@favornoms/database/server';
import { ShiftsView } from './_components/shifts-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export const metadata = { title: 'Shifts · Favornoms admin' };

export default async function ShiftsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const [{ data: shifts }, { data: staff }] = await Promise.all([
    supabase
      .from('staff_shifts')
      .select('id, staff_member_id, clocked_in_at, clocked_out_at, shift_role, notes')
      .eq('branch_id', branchId)
      .gte('clocked_in_at', weekAgo)
      .order('clocked_in_at', { ascending: false }),
    supabase
      .from('staff_members')
      .select('id, role, status, user_id, invited_email')
      .eq('branch_id', branchId)
      .eq('status', 'active'),
  ]);

  return <ShiftsView branchId={branchId} shifts={(shifts ?? []) as never[]} staff={(staff ?? []) as never[]} />;
}
