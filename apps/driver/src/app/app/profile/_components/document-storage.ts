import { getBrowserClient } from '@favornoms/database/client';
import { docKeyOf, type DocFile, type DocKey } from './documents';

function isNewer(candidate: string | null, current: string | null): boolean {
  if (!candidate) return false;
  if (!current) return true;
  return new Date(candidate).getTime() > new Date(current).getTime();
}

/**
 * Read the rider's own KYC folder.
 *
 * The error is returned rather than swallowed. Every previous caller dropped it, and a
 * denied or failed `list()` then rendered as three "Not uploaded" rows — the opposite of
 * the truth for a rider who had sent everything. The admin side of that bug was fixed;
 * this is the rider side.
 */
export async function listDriverDocuments(
  driverId: string,
  withPreviews: boolean,
): Promise<{ docs: DocFile[]; error: string | null }> {
  const supabase = getBrowserClient();
  const { data, error } = await supabase.storage.from('driver-kyc').list(driverId, { limit: 50 });
  if (error) return { docs: [], error: error.message };

  // The folder also holds the payout QR, so only entries named after one of the three
  // document keys count. And an upsert replaces one object NAME, so re-sending a licence
  // as .png leaves the old license.jpg beside it — keep the newest per key, or the screen
  // shows the file that was replaced.
  const newest = new Map<DocKey, { name: string; receivedAt: string | null }>();
  for (const file of data ?? []) {
    const key = docKeyOf(file.name);
    if (!key) continue;
    const receivedAt = file.updated_at ?? file.created_at ?? null;
    const current = newest.get(key);
    if (!current || isNewer(receivedAt, current.receivedAt)) {
      newest.set(key, { name: file.name, receivedAt });
    }
  }
  const entries = [...newest.entries()];

  let signed: Array<{ signedUrl: string | null }> | null = null;
  if (withPreviews && entries.length > 0) {
    const paths = entries.map(([, e]) => `${driverId}/${e.name}`);
    // driver-kyc is private (driver_kyc_self_read lets the rider read their own folder),
    // so a thumbnail needs a signed URL rather than a public one.
    const { data: urls } = await supabase.storage
      .from('driver-kyc')
      .createSignedUrls(paths, 60 * 10);
    signed = urls ?? null;
  }

  return {
    docs: entries.map(([key, entry], i) => ({
      key,
      name: entry.name,
      url: signed?.[i]?.signedUrl ?? null,
      receivedAt: entry.receivedAt,
    })),
    error: null,
  };
}

/**
 * Send one document. Returns null on success, or a message to show inline.
 *
 * Storage writes its object metadata to Postgres, so a busy database surfaces here as
 * "the connection to the database timed out" and the rider is simply stuck — they cannot
 * get verified and cannot work. Those failures are transient far more often than not, so
 * retry with backoff before giving up.
 */
export async function uploadDriverDocument(
  driverId: string,
  key: DocKey,
  file: File,
): Promise<string | null> {
  const supabase = getBrowserClient();
  const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg';
  const path = `${driverId}/${key}.${ext}`;

  let lastMessage = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { error } = await supabase.storage
      .from('driver-kyc')
      .upload(path, file, { upsert: true, contentType: file.type });
    if (!error) return null;
    lastMessage = error.message;
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
  }
  return lastMessage;
}
