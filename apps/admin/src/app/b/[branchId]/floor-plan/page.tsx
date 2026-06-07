import { getServerClient } from '@favornoms/database/server';
import { FloorPlanView } from './_components/floor-plan-view';

interface Props { params: Promise<{ branchId: string }> }

export const metadata = { title: 'Floor plan · Favornoms admin' };

export default async function FloorPlanPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: tables } = await supabase
    .from('v_branch_floor_plan')
    .select('id, table_number, display_name, capacity, zone, status, pos_x, pos_y, pos_w, pos_h, shape, open_orders')
    .eq('branch_id', branchId);
  return <FloorPlanView branchId={branchId} initial={(tables ?? []) as never[]} />;
}
