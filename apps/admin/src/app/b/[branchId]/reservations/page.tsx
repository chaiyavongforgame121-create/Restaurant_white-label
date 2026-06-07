import { getServerClient } from '@favornoms/database/server';
import { listReservationsForBranch } from '@favornoms/database/queries';
import { ReservationsView } from './_components/reservations-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function ReservationsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  // Pull next 30 days of reservations
  const now = new Date();
  const horizon = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const reservations = await listReservationsForBranch(supabase, branchId, {
    from: new Date(now.getTime() - 6 * 60 * 60 * 1000).toISOString(),
    to: horizon.toISOString(),
  });

  return <ReservationsView branchId={branchId} initialRows={reservations} />;
}
