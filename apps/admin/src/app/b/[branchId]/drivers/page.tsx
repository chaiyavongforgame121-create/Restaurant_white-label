import { getServerClient } from '@favornoms/database/server';
import { Badge, Card } from '@favornoms/ui';
import { ApproveButton } from './_components/approve-button';
import { KycReviewButton } from './_components/kyc-review-button';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function DriversPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: approvals } = await supabase
    .from('driver_approvals')
    .select(
      'id, status, applied_at, reviewed_at, notes, driver:drivers(id, full_name, phone, vehicle_type, vehicle_plate, kyc_status, average_rating)',
    )
    .eq('branch_id', branchId)
    .order('applied_at', { ascending: false });

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Drivers</h1>
        <p className="mt-1 text-muted-foreground">
          {approvals?.length ?? 0} drivers applied to this branch
        </p>
      </header>

      {(approvals?.length ?? 0) === 0 ? (
        <Card className="p-8 text-center text-muted-foreground">
          No driver applications yet. Drivers can apply via the Driver app.
        </Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {(approvals ?? []).map((a) => {
            const d = a.driver as unknown as {
              id: string;
              full_name: string;
              phone: string;
              vehicle_type: string;
              vehicle_plate?: string;
              kyc_status: string;
              average_rating?: number;
            };
            return (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-display text-lg font-semibold">{d?.full_name ?? 'Unknown driver'}</p>
                      <p className="text-sm text-muted-foreground">
                        {d?.phone} · {d?.vehicle_type} {d?.vehicle_plate ?? ''}
                      </p>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge
                          variant={d?.kyc_status === 'verified' ? 'success' : 'warning'}
                        >
                          KYC: {d?.kyc_status}
                        </Badge>
                        {d?.average_rating != null && (
                          <Badge variant="muted">⭐ {Number(d.average_rating).toFixed(1)}</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={
                        a.status === 'approved' ? 'success' :
                        a.status === 'rejected' ? 'danger' :
                        a.status === 'suspended' ? 'warning' :
                        'muted'
                      }>
                        {a.status}
                      </Badge>
                      {d?.id && (
                        <KycReviewButton driverId={d.id} currentStatus={d.kyc_status} />
                      )}
                      {a.status === 'pending' && (
                        <ApproveButton approvalId={a.id} />
                      )}
                    </div>
                  </div>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
