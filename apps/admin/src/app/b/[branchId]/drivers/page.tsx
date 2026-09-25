import { getLocale, getTranslations } from 'next-intl/server';
import { DEFAULT_UI_LOCALE, formatPhone, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { resolveDeliveryGate } from '@/lib/delivery-gate';
import { AccessDenied } from '@/components/access-denied';
import { DeliveryLocked } from '@/components/delivery-locked';
import { ApproveButton } from './_components/approve-button';
import { KycReviewButton } from './_components/kyc-review-button';
import { DriverAppCard } from './_components/driver-app-card';
import { configuredDriverAppUrl } from './_lib/driver-app-url';
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

/** Values with a label under drivers.approval / drivers.kycStatus / drivers.vehicle. */
const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'suspended'];
const KYC_STATUSES = ['pending', 'verified', 'rejected', 'suspended'];
const VEHICLE_TYPES = ['motorcycle', 'car', 'bicycle', 'scooter'];

const EMPTY_DOCS: DriverDocSummary = {
  entries: [],
  received: 0,
  lastReceivedAt: null,
  error: null,
};

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
  const [t, requestLocale] = await Promise.all([getTranslations('drivers'), getLocale()]);
  const locale = isUiLocale(requestLocale) ? requestLocale : DEFAULT_UI_LOCALE;
  const dateFormat = new Intl.DateTimeFormat(intlLocaleFor(locale), {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  const fmt = (ts: string | null): string | null => (ts ? dateFormat.format(new Date(ts)) : null);

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
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  // A rider roster for a branch that does not deliver is a roster nothing can dispatch:
  // find_dispatch_candidates only ever offers a run to riders approved at a delivering
  // branch. The entitlement was never asked here, so the screen worked regardless.
  const gate = await resolveDeliveryGate(supabase, branchId);
  const driverAppUrl = configuredDriverAppUrl();
  if (!gate.delivers) {
    // The rider app's code stays reachable while delivery is off: a merchant can line up
    // riders before switching delivery on, and riders apply to any active branch.
    return (
      <>
        <DeliveryLocked branchId={branchId} branchName={branch.name} gate={gate} />
        <div className="container -mt-10 max-w-2xl pb-16">
          <DriverAppCard url={driverAppUrl} audience="team" branchName={branch.name} />
        </div>
      </>
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
  if (error) console.error('Drivers: could not load driver applications:', error.message);

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

  // Separate facts, one short phrase each, joined like a list.
  const summary = [
    t('header.applied', { count: rows.length }),
    pendingCount > 0 ? t('header.awaitingDecision', { count: pendingCount }) : null,
    kycWaiting > 0 ? t('header.documentsToReview', { count: kycWaiting }) : null,
    changedCount > 0 ? t('header.changedAfterReview', { count: changedCount }) : null,
  ]
    .filter(Boolean)
    .join(' · ');

  const kycLabel = (status: string | undefined) =>
    status == null
      ? t('kycStatus.unknown')
      : KYC_STATUSES.includes(status)
        ? t(`kycStatus.${status}`)
        : status;

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('header.title')}</h1>
        <p className="mt-1 text-muted-foreground">{summary}</p>
      </header>

      {/* Above the roster rather than under it: with nobody applied yet it is the next step,
          and a long roster would otherwise bury the only place the app's address is given. */}
      <div className="mb-6 px-2 lg:px-0">
        <DriverAppCard url={driverAppUrl} audience="team" branchName={branch.name} />
      </div>

      {/* A failed read used to render as the friendly empty state, so an RLS denial or a 500
          was indistinguishable from "nobody has applied". */}
      {error ? (
        <Card className="border-danger/40 bg-danger/5 p-6">
          <p className="font-semibold text-danger">{t('loadError.title')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{t('loadError.body')}</p>
        </Card>
      ) : rows.length === 0 ? (
        <Card className="p-8 text-center">
          <p className="font-semibold">{t('empty.title')}</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">{t('empty.body')}</p>
        </Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {rows.map((a, i) => {
            const d = drivers[i] ?? null;
            const docs = d ? (docsByDriver.get(d.id) ?? EMPTY_DOCS) : EMPTY_DOCS;
            const applied = fmt(a.applied_at);
            const reviewed = fmt(a.reviewed_at);
            const received = formatReceived(docs.lastReceivedAt, locale);
            const changedSinceVerify = decidedBeforeUpload(
              d?.kyc_verified_at ?? null,
              docs.lastReceivedAt,
            );
            const changedSinceDecision = decidedBeforeUpload(a.reviewed_at, docs.lastReceivedAt);
            const vehicle = d?.vehicle_type
              ? VEHICLE_TYPES.includes(d.vehicle_type)
                ? t(`vehicle.${d.vehicle_type}`)
                : d.vehicle_type
              : '';
            const timeline = [
              t('card.applied', { date: applied ?? '' }),
              reviewed ? t('card.reviewed', { date: reviewed }) : null,
              received ? t('card.documentsReceived', { date: received }) : null,
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <li key={a.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-display text-lg font-semibold">
                        {d?.full_name ?? t('card.unknownDriver')}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {d?.phone ? formatPhone(d.phone) : ''} · {vehicle} {d?.vehicle_plate ?? ''}
                      </p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-2">
                        <Badge variant={d?.kyc_status === 'verified' ? 'success' : 'warning'}>
                          {t('card.kyc', { status: kycLabel(d?.kyc_status) })}
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
                            ? t('card.documentsUnreadable')
                            : t('card.documentsCount', {
                                received: docs.received,
                                total: DOC_TYPES.length,
                              })}
                        </Badge>
                        {d?.average_rating != null && (
                          <Badge variant="muted">⭐ {Number(d.average_rating).toFixed(1)}</Badge>
                        )}
                      </div>
                      <p className="mt-1.5 text-xs text-muted-foreground">{timeline}</p>
                      {a.notes && (
                        <p className="mt-1.5 rounded-lg bg-muted/50 px-2.5 py-1.5 text-xs text-muted-foreground">
                          {t.rich('card.note', {
                            note: a.notes,
                            label: (chunks) => <span className="font-semibold">{chunks}</span>,
                          })}
                        </p>
                      )}
                      {/* Approving the application and verifying the documents are two separate
                          decisions on one screen; an approved rider whose KYC is still pending
                          reads as "done" unless we say otherwise. */}
                      {a.status === 'approved' && d?.kyc_status === 'pending' && (
                        <p className="mt-1.5 text-xs font-semibold text-warning">
                          {t('card.approvedNeedsDocuments')}
                        </p>
                      )}
                      {changedSinceVerify ? (
                        <p className="mt-1.5 text-xs font-semibold text-warning">
                          {t('card.replacedAfterVerify', {
                            received: received ?? '',
                            verified: fmt(d?.kyc_verified_at ?? null) ?? '',
                          })}
                        </p>
                      ) : (
                        changedSinceDecision && (
                          <p className="mt-1.5 text-xs font-semibold text-warning">
                            {t('card.replacedAfterDecision', {
                              received: received ?? '',
                              reviewed: reviewed ?? '',
                            })}
                          </p>
                        )
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-2">
                      <Badge variant={STATUS_VARIANT[a.status] ?? 'muted'}>
                        {APPROVAL_STATUSES.includes(a.status) ? t(`approval.${a.status}`) : a.status}
                      </Badge>
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
