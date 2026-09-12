import { formatPhone } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { ApproveButton } from './_components/approve-button';
import { KycReviewButton } from './_components/kyc-review-button';
import {
  decidedBeforeUpload,
  DOC_TYPES,
  formatReceived,
  loadDriverDocs,
  type DriverDocSummary,
} from './_components/driver-docs';

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

const EMPTY_DOCS: DriverDocSummary = {
  entries: [],
  received: 0,
  lastReceivedAt: null,
  error: null,
};

function fmt(ts: string | null): string | null {
  if (!ts) return null;
  return new Date(ts).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/**
 * Whether the rider's documents arrived at all, and when, is only knowable by listing
 * their folder — there is no column for it. One call per rider, in small batches so a
 * branch with a long roster does not open fifty sockets at once.
 */
async function loadDocsByDriver(
  storage: Parameters<typeof loadDriverDocs>[0],
  driverIds: string[],
): Promise<Map<string, DriverDocSummary>> {
  const byDriver = new Map<string, DriverDocSummary>();
  const batchSize = 8;
  for (let i = 0; i < driverIds.length; i += batchSize) {
    const batch = driverIds.slice(i, i + batchSize);
    const summaries = await Promise.all(batch.map((id) => loadDriverDocs(storage, id)));
    batch.forEach((id, index) => {
      const summary = summaries[index];
      if (summary) byDriver.set(id, summary);
    });
  }
  return byDriver;
}

export default async function DriversPage({ params }: Props) {
  const { branchId } = await params;
  // Every other back-office page asks for its capability; this one only ever leaned on the
  // layout's backoffice.access gate, so a role that cannot manage riders still saw the
  // roster (and the sidebar link that hid it from them was the only thing saying otherwise).
  const { supabase, branch, can, user } = await getBranchAccess(
    branchId,
    `/b/${branchId}/drivers`,
  );

  if (!can('drivers.manage')) {
    return (
      <AccessDenied
        title="No driver access"
        reason={`Your role cannot review riders at ${branch.name}.`}
      />
    );
  }

  // `driver_approvals.reviewed_by` references auth.users(id) (verified against the live
  // constraint; the generated types.ts wrongly says staff_members). Platform admins have
  // no staff row and legitimately record NULL.
  const reviewerId = user.id;
  const { data: approvals, error } = await supabase
    .from('driver_approvals')
    .select(
      'id, status, applied_at, reviewed_at, notes, driver:drivers(id, full_name, phone, vehicle_type, vehicle_plate, kyc_status, kyc_verified_at, average_rating)',
    )
    .eq('branch_id', branchId)
    .order('applied_at', { ascending: false });

  const rows = approvals ?? [];
  const drivers = rows.map(
    (a) =>
      a.driver as unknown as {
        id: string;
        full_name: string;
        phone: string;
        vehicle_type: string;
        vehicle_plate?: string;
        kyc_status: string;
        kyc_verified_at?: string | null;
        average_rating?: number;
      } | null,
  );
  const docsByDriver = await loadDocsByDriver(
    supabase.storage,
    [...new Set(drivers.flatMap((d) => (d ? [d.id] : [])))],
  );

  const pendingCount = rows.filter((a) => a.status === 'pending').length;
  const kycWaiting = drivers.filter((d) => d?.kyc_status === 'pending').length;
  // A replaced document is invisible everywhere else: the upload writes nothing, so a
  // rider can swap a licence and stay verified on a review that was about the old file.
  const changedCount = rows.filter((a, i) => {
    const d = drivers[i];
    const docs = d ? (docsByDriver.get(d.id) ?? EMPTY_DOCS) : EMPTY_DOCS;
    return (
      decidedBeforeUpload(d?.kyc_verified_at ?? null, docs.lastReceivedAt) ||
      decidedBeforeUpload(a.reviewed_at, docs.lastReceivedAt)
    );
  }).length;

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">Drivers</h1>
        <p className="mt-1 text-muted-foreground">
          {rows.length} {rows.length === 1 ? 'driver has' : 'drivers have'} applied to this branch
          {pendingCount > 0 && ` · ${pendingCount} awaiting your decision`}
          {kycWaiting > 0 && ` · ${kycWaiting} with documents to review`}
          {changedCount > 0 && ` · ${changedCount} changed a document after review`}
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
          {rows.map((a, i) => {
            const d = drivers[i] ?? null;
            const docs = d ? (docsByDriver.get(d.id) ?? EMPTY_DOCS) : EMPTY_DOCS;
            const applied = fmt(a.applied_at);
            const reviewed = fmt(a.reviewed_at);
            const received = formatReceived(docs.lastReceivedAt);
            const changedSinceVerify = decidedBeforeUpload(
              d?.kyc_verified_at ?? null,
              docs.lastReceivedAt,
            );
            const changedSinceDecision = decidedBeforeUpload(a.reviewed_at, docs.lastReceivedAt);
            return (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-display text-lg font-semibold">
                        {d?.full_name ?? 'Unknown driver'}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {d?.phone ? formatPhone(d.phone) : ''} · {d?.vehicle_type} {d?.vehicle_plate ?? ''}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge variant={d?.kyc_status === 'verified' ? 'success' : 'warning'}>
                          KYC: {d?.kyc_status ?? 'unknown'}
                        </Badge>
                        {/* Received is not the same question as verified, and it is the one
                            a rider keeps asking. A read that failed says so rather than
                            posing as "0 of 3". */}
                        <Badge
                          variant={
                            docs.error
                              ? 'danger'
                              : docs.received === DOC_TYPES.length
                                ? 'muted'
                                : 'warning'
                          }
                        >
                          {docs.error
                            ? 'Documents: could not read'
                            : `Documents: ${docs.received}/${DOC_TYPES.length} received`}
                        </Badge>
                        {d?.average_rating != null && (
                          <Badge variant="muted">⭐ {Number(d.average_rating).toFixed(1)}</Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        Applied {applied}
                        {reviewed && ` · reviewed ${reviewed}`}
                        {received && ` · documents last received ${received}`}
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
                          Approved, but their documents still need reviewing — use Review
                          documents.
                        </p>
                      )}
                      {changedSinceVerify ? (
                        <p className="mt-1.5 text-xs font-semibold text-warning">
                          They replaced a document {received}, after it was verified on{' '}
                          {fmt(d?.kyc_verified_at ?? null)} — look again.
                        </p>
                      ) : (
                        changedSinceDecision && (
                          <p className="mt-1.5 text-xs font-semibold text-warning">
                            They replaced a document {received}, after your decision on{' '}
                            {reviewed}.
                          </p>
                        )
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={STATUS_VARIANT[a.status] ?? 'muted'}>{a.status}</Badge>
                      {d?.id && (
                        <KycReviewButton
                          driverId={d.id}
                          currentStatus={d.kyc_status}
                          kycVerifiedAt={d.kyc_verified_at ?? null}
                          branchReviewedAt={a.reviewed_at}
                          branchName={branch.name}
                        />
                      )}
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
