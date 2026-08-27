import { getServerClient } from '@favornoms/database/server';
import { Badge, Card } from '@favornoms/ui';
import { ApproveButton } from './_components/approve-button';
import { KycReviewButton } from './_components/kyc-review-button';

interface Props {
  params: Promise<{ branchId: string }>;
}

type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'suspended';

const STATUS_VARIANT: Record<string, 'success' | 'danger' | 'warning' | 'muted'> = {
  approved: 'success',
  rejected: 'danger',
  suspended: 'warning',
  pending: 'muted',
};

function fmt(ts: string | null): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

export default async function DriversPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();

  // The reviewer's auth-user id. `driver_approvals.reviewed_by` references auth.users(id)
  // (verified against the live constraint; the generated types.ts wrongly says
  // staff_members). Platform admins have no staff row and legitimately record NULL.
  const [{ data: userData }, { data: approvals, error }] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from('driver_approvals')
      .select(
        'id, status, applied_at, reviewed_at, notes, driver:drivers(id, full_name, phone, vehicle_type, vehicle_plate, kyc_status, average_rating)',
      )
      .eq('branch_id', branchId)
      .order('applied_at', { ascending: false }),
  ]);

  const reviewerId = userData?.user?.id ?? null;
  const rows = approvals ?? [];
  const pendingCount = rows.filter((a) => a.status === 'pending').length;
  const kycWaiting = rows.filter(
    (a) => (a.driver as unknown as { kyc_status?: string } | null)?.kyc_status === 'pending',
  ).length;

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Drivers</h1>
        <p className="mt-1 text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'driver has' : 'drivers have'} applied to this branch
          {pendingCount > 0 && ` · ${pendingCount} awaiting your decision`}
          {kycWaiting > 0 && ` · ${kycWaiting} with documents to review`}
        </p>
      </header>

      {/* A failed read used to render as the friendly empty state, so an RLS denial or a 500
          was indistinguishable from "nobody has applied". */}
      {error ? (
        <Card className="border-danger/40 bg-danger/5 p-6">
          <p className="font-semibold text-danger">Could not load driver applications</p>
          <p className="mt-1 text-sm text-muted-foreground">{error.message}</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-semibold">No driver applications yet</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Riders apply from the Driver app. They can only apply after uploading all three
            KYC documents (licence, vehicle registration and a selfie), so a rider who has
            signed up but not finished uploading will not appear here yet.
          </p>
        </Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {rows.map((a) => {
            const d = a.driver as unknown as {
              id: string;
              full_name: string;
              phone: string;
              vehicle_type: string;
              vehicle_plate?: string;
              kyc_status: string;
              average_rating?: number;
            } | null;
            const applied = fmt(a.applied_at);
            const reviewed = fmt(a.reviewed_at);
            return (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-display text-lg font-semibold">
                        {d?.full_name ?? 'Unknown driver'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {d?.phone} · {d?.vehicle_type} {d?.vehicle_plate ?? ''}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge variant={d?.kyc_status === 'verified' ? 'success' : 'warning'}>
                          KYC: {d?.kyc_status ?? 'unknown'}
                        </Badge>
                        {d?.average_rating != null && (
                          <Badge variant="muted">⭐ {Number(d.average_rating).toFixed(1)}</Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Applied {applied}
                        {reviewed && ` · reviewed ${reviewed}`}
                      </p>
                      {a.notes && (
                        <p className="mt-1.5 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                          <span className="font-semibold">Note:</span> {a.notes}
                        </p>
                      )}
                      {/* Approving the application and verifying the documents are two separate
                          decisions on one screen; an approved rider whose KYC is still pending
                          reads as "done" unless we say otherwise. */}
                      {a.status === 'approved' && d?.kyc_status === 'pending' && (
                        <p className="mt-1.5 text-xs font-semibold text-warning">
                          Approved, but their documents still need reviewing — use Review KYC.
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={STATUS_VARIANT[a.status] ?? 'muted'}>{a.status}</Badge>
                      {d?.id && <KycReviewButton driverId={d.id} currentStatus={d.kyc_status} />}
                      <ApproveButton
                        approvalId={a.id}
                        currentStatus={a.status as ApprovalStatus}
                        reviewerId={reviewerId}
                      />
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
