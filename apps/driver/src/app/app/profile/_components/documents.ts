import type { DriverApproval } from '@favornoms/database/queries';

/**
 * The three files a rider must send. The key is not a label — it is the storage object
 * name, `driver-kyc/{driverId}/{key}.{ext}` — so it has to match the admin review modal
 * and the apply screen exactly. The rider's payout QR lives in the same folder under
 * `payout_qr.*`, which is why every read here filters by key rather than taking the
 * folder listing as-is.
 *
 * What each one is called on screen, and the hint under it, is in the `profile` catalogue:
 * `docs.{key}.label` (a heading), `docs.{key}.inline` (inside a sentence) and `docs.{key}.hint`.
 */
export const DOC_KEYS = ['license', 'vehicle_reg', 'selfie'] as const;
export type DocKey = (typeof DOC_KEYS)[number];

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

/**
 * `stale` — approved, but before the rider replaced a document.
 * The label and the sentence under it are `documents.branchState.{code}.label` / `.detail`
 * in the `profile` catalogue.
 */
export type BranchVerificationCode = 'stale' | 'cleared' | 'pending' | 'rejected' | 'paused';

export interface BranchVerification {
  code: BranchVerificationCode;
  variant: 'success' | 'warning' | 'danger' | 'info';
}

/**
 * What ONE restaurant has done about this rider.
 *
 * `driver_approvals` is per-branch, so this is the only verdict that differs between
 * restaurants. The document check itself (`drivers.kyc_status`) is a single shared column
 * — see `documents.byRestaurant.sharedNote` — so the screen must not imply each restaurant
 * re-examined the files.
 */
export function branchVerification(
  approval: DriverApproval,
  receivedAt: string | null,
): BranchVerification {
  switch (approval.status) {
    case 'approved':
      return decidedBeforeUpload(approval.reviewed_at, receivedAt)
        ? { code: 'stale', variant: 'warning' }
        : { code: 'cleared', variant: 'success' };
    case 'pending':
      return { code: 'pending', variant: 'info' };
    case 'rejected':
      return { code: 'rejected', variant: 'danger' };
    default:
      return { code: 'paused', variant: 'warning' };
  }
}

/**
 * One line for the Profile row, so a rider sees the state without opening the screen.
 * A key under `summary` in the `profile` catalogue plus the numbers it needs.
 */
export type DocumentsSummary =
  | { key: 'unreadable' | 'awaiting' | 'rechecking' | 'changesNeeded' | 'verifiedApplyNext'; values?: undefined }
  | { key: 'incomplete'; values: { missing: number; total: number } }
  | { key: 'verifiedCleared'; values: { count: number } };

export function documentsSummary(
  stage: DocsStage,
  docs: readonly DocFile[],
  approvals: readonly DriverApproval[],
): DocumentsSummary {
  const cleared = approvals.filter((a) => a.status === 'approved').length;
  switch (stage) {
    case 'unreadable':
      return { key: 'unreadable' };
    case 'incomplete':
      return {
        key: 'incomplete',
        values: { missing: missingDocKeys(docs).length, total: DOC_KEYS.length },
      };
    case 'awaiting':
      return { key: 'awaiting' };
    case 'rechecking':
      return { key: 'rechecking' };
    case 'changes_needed':
      return { key: 'changesNeeded' };
    default:
      return cleared > 0
        ? { key: 'verifiedCleared', values: { count: cleared } }
        : { key: 'verifiedApplyNext' };
  }
}
