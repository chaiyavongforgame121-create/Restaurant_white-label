import type { DriverApproval } from '@favornoms/database/queries';

/**
 * The three files a rider must send. The key is not a label — it is the storage object
 * name, `driver-kyc/{driverId}/{key}.{ext}` — so it has to match the admin review modal
 * and the apply screen exactly. The rider's payout QR lives in the same folder under
 * `payout_qr.*`, which is why every read here filters by key rather than taking the
 * folder listing as-is.
 */
export const DOC_KEYS = ['license', 'vehicle_reg', 'selfie'] as const;
export type DocKey = (typeof DOC_KEYS)[number];

export const DOC_LABEL: Record<DocKey, string> = {
  license: 'Driver licence',
  vehicle_reg: 'Vehicle registration',
  selfie: 'Selfie with licence',
};

export const DOC_HINT: Record<DocKey, string> = {
  license: 'Both sides if your details are printed on the back.',
  vehicle_reg: 'For the vehicle you actually deliver on.',
  selfie: 'You holding your licence — face and licence both readable.',
};

export interface DocFile {
  key: DocKey;
  /** Object name inside the rider's folder, e.g. `license.jpg`. */
  name: string;
  /** Signed preview URL. driver-kyc is private, so this one expires. */
  url: string | null;
  /**
   * When storage last accepted this file. Uploads are `upsert`, so this moves every time
   * the rider replaces the document — it is the only "we received it at" that exists.
   */
  receivedAt: string | null;
}

/** The document a storage entry belongs to, or null for anything else in the folder. */
export function docKeyOf(fileName: string): DocKey | null {
  const key = fileName.split('.')[0] ?? '';
  return (DOC_KEYS as readonly string[]).includes(key) ? (key as DocKey) : null;
}

export function missingDocKeys(docs: readonly DocFile[]): DocKey[] {
  const have = new Set(docs.map((d) => d.key));
  return DOC_KEYS.filter((k) => !have.has(k));
}

/** The most recent moment storage accepted any of the three documents. */
export function lastReceivedAt(docs: readonly DocFile[]): string | null {
  let latest: string | null = null;
  for (const doc of docs) {
    if (!doc.receivedAt) continue;
    if (!latest || new Date(doc.receivedAt).getTime() > new Date(latest).getTime()) {
      latest = doc.receivedAt;
    }
  }
  return latest;
}

/**
 * True when a decision was taken before the newest file arrived — i.e. whoever looked was
 * looking at a document the rider has since replaced. Nothing in the database records
 * this; it only exists because storage stamps every upsert, so both sides of the app
 * derive it the same way rather than trusting the decision timestamp on its own.
 */
export function decidedBeforeUpload(
  decidedAt: string | null,
  receivedAt: string | null,
): boolean {
  if (!decidedAt || !receivedAt) return false;
  return new Date(receivedAt).getTime() > new Date(decidedAt).getTime();
}

export type DocsStage =
  | 'unreadable'
  | 'incomplete'
  | 'awaiting'
  | 'rechecking'
  | 'verified'
  | 'changes_needed';

export interface DocsSnapshot {
  listFailed: boolean;
  docs: readonly DocFile[];
  kycStatus: string;
  kycVerifiedAt: string | null;
}

export function documentsStage(snapshot: DocsSnapshot): DocsStage {
  // A storage read that failed is not "you sent nothing". Both rider screens used to draw
  // a denial as three empty rows, so a rider who had uploaded everything was told they had
  // uploaded nothing — and there was no way for them to tell the two apart.
  if (snapshot.listFailed) return 'unreadable';
  if (missingDocKeys(snapshot.docs).length > 0) return 'incomplete';
  if (snapshot.kycStatus === 'rejected' || snapshot.kycStatus === 'suspended') {
    return 'changes_needed';
  }
  if (snapshot.kycStatus === 'verified') {
    return decidedBeforeUpload(snapshot.kycVerifiedAt, lastReceivedAt(snapshot.docs))
      ? 'rechecking'
      : 'verified';
  }
  return 'awaiting';
}

export const STAGE_TONE: Record<DocsStage, 'success' | 'warning' | 'danger' | 'info'> = {
  unreadable: 'danger',
  incomplete: 'warning',
  awaiting: 'info',
  rechecking: 'warning',
  verified: 'success',
  changes_needed: 'danger',
};

export interface BranchVerification {
  label: string;
  variant: 'success' | 'warning' | 'danger' | 'info';
  detail: string;
}

/**
 * What ONE restaurant has done about this rider.
 *
 * `driver_approvals` is per-branch, so this is the only verdict that differs between
 * restaurants. The document check itself (`drivers.kyc_status`) is a single shared column
 * — see `SHARED_CHECK_NOTE` — so the screen must not imply each restaurant re-examined
 * the files.
 */
export function branchVerification(
  approval: DriverApproval,
  receivedAt: string | null,
): BranchVerification {
  switch (approval.status) {
    case 'approved':
      return decidedBeforeUpload(approval.reviewed_at, receivedAt)
        ? {
            label: 'Checked before your update',
            variant: 'warning',
            detail:
              'You replaced a document after they cleared you. They may want to look again — you keep delivering here in the meantime.',
          }
        : {
            label: 'Cleared to deliver',
            variant: 'success',
            detail: 'They have seen your documents and approved you.',
          };
    case 'pending':
      return {
        label: 'Awaiting verification',
        variant: 'info',
        detail: 'They have your documents. Nobody here has decided yet.',
      };
    case 'rejected':
      return {
        label: 'Not accepted',
        variant: 'danger',
        detail: 'They turned this application down.',
      };
    default:
      return {
        label: 'Paused',
        variant: 'warning',
        detail: 'They have paused you here, so you will not get their orders.',
      };
  }
}

/**
 * The one thing about this screen a rider cannot work out for themselves: the document
 * check is not per-restaurant. `drivers.kyc_status` is a single column every branch reads,
 * so the first restaurant to verify clears the rider everywhere. Only the approval below
 * is that restaurant's own.
 */
export const SHARED_CHECK_NOTE =
  'Your documents are checked once and that result is shared with every restaurant. Each restaurant then decides separately whether you may deliver for them.';

/** One line for the Profile row, so a rider sees the state without opening the screen. */
export function documentsSummary(
  stage: DocsStage,
  docs: readonly DocFile[],
  approvals: readonly DriverApproval[],
): string {
  const cleared = approvals.filter((a) => a.status === 'approved').length;
  switch (stage) {
    case 'unreadable':
      return 'Could not check your documents just now';
    case 'incomplete': {
      const missing = missingDocKeys(docs).length;
      return `${missing} of ${DOC_KEYS.length} still to send`;
    }
    case 'awaiting':
      return 'All received — awaiting verification';
    case 'rechecking':
      return 'You replaced a document since it was checked';
    case 'changes_needed':
      return 'A document needs changing';
    default:
      return cleared > 0
        ? `Verified · ${cleared} ${cleared === 1 ? 'restaurant' : 'restaurants'} cleared you`
        : 'Verified — apply to a restaurant next';
  }
}
