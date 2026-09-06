/**
 * Reading a rider's KYC folder, shared by the server-rendered roster and the review modal.
 *
 * Nothing in the database records that documents arrived, so `storage.objects` is the only
 * evidence there is: the object's own timestamp is the "received at", and comparing it
 * against a decision timestamp is the only way either side can tell that a rider replaced
 * a file after somebody reviewed it.
 *
 * Deliberately isomorphic — it takes a structural view of `supabase.storage` rather than
 * importing a client — so the server page and the 'use client' modal agree on the same
 * three keys, the same filtering and the same staleness rule.
 */

export const DOC_TYPES = [
  { key: 'license', label: 'Driver licence' },
  { key: 'vehicle_reg', label: 'Vehicle registration' },
  { key: 'selfie', label: 'Selfie with licence' },
] as const;

export type DocKey = (typeof DOC_TYPES)[number]['key'];

const DOC_KEYS: readonly string[] = DOC_TYPES.map((d) => d.key);

export interface DriverDocEntry {
  key: DocKey;
  /** Object name inside the rider's folder, e.g. `license.jpg`. */
  name: string;
  receivedAt: string | null;
}

export interface DriverDocSummary {
  entries: DriverDocEntry[];
  /** How many of the three the rider has actually sent. */
  received: number;
  /** The newest of them — when this rider last changed anything. */
  lastReceivedAt: string | null;
  /** A read that failed. Null and an empty list are NOT the same thing. */
  error: string | null;
}

interface StorageFile {
  name: string;
  updated_at?: string | null;
  created_at?: string | null;
}

interface StorageLister {
  from(bucket: string): {
    list(
      path: string,
      options?: { limit?: number },
    ): PromiseLike<{ data: StorageFile[] | null; error: { message: string } | null }>;
  };
}

function isNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return new Date(candidate).getTime() > new Date(current).getTime();
}

export function summariseDriverDocs(
  files: StorageFile[] | null,
  error: string | null,
): DriverDocSummary {
  if (error) return { entries: [], received: 0, lastReceivedAt: null, error };

  // The folder also holds the rider's payout QR, and an upsert only replaces the same
  // object NAME — so a licence re-sent as .png sits beside the old .jpg. Take the newest
  // per key, or the merchant reviews the file the rider already replaced.
  const newest = new Map<DocKey, DriverDocEntry>();
  for (const file of files ?? []) {
    const key = file.name.split('.')[0] ?? '';
    if (!DOC_KEYS.includes(key)) continue;
    const receivedAt = file.updated_at ?? file.created_at ?? null;
    const current = newest.get(key as DocKey);
    if (!current || isNewer(receivedAt, current.receivedAt)) {
      newest.set(key as DocKey, { key: key as DocKey, name: file.name, receivedAt });
    }
  }

  const entries = DOC_TYPES.flatMap((doc) => {
    const found = newest.get(doc.key);
    return found ? [found] : [];
  });
  let lastReceivedAt: string | null = null;
  for (const entry of entries) {
    if (isNewer(entry.receivedAt, lastReceivedAt)) lastReceivedAt = entry.receivedAt;
  }
  return { entries, received: entries.length, lastReceivedAt, error: null };
}

export async function loadDriverDocs(
  storage: StorageLister,
  driverId: string,
): Promise<DriverDocSummary> {
  const { data, error } = await storage.from('driver-kyc').list(driverId, { limit: 50 });
  return summariseDriverDocs(data, error?.message ?? null);
}

/**
 * True when the decision predates the newest file — whoever looked was looking at a
 * document the rider has since replaced.
 */
export function decidedBeforeUpload(
  decidedAt: string | null,
  lastReceivedAt: string | null,
): boolean {
  if (!decidedAt || !lastReceivedAt) return false;
  return new Date(lastReceivedAt).getTime() > new Date(decidedAt).getTime();
}

/** Short, absolute and with a time — the whole point is comparing two moments. */
export function formatReceived(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}
