import { getServerClient } from '@favornoms/database/server';
import { LiveOpsView } from './_components/live-ops-view';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function DeliveriesPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, geo_lat, geo_lng')
    .eq('id', branchId)
    .single();

  return (
    <LiveOpsView
      branchId={branchId}
      branchName={branch?.name ?? 'Branch'}
      branchLat={branch?.geo_lat ?? null}
      branchLng={branch?.geo_lng ?? null}
    />
  );
}
