import type { getBrowserClient } from '@favornoms/database/client';

/** Browser and server clients are the same type here, so one alias covers both callers. */
type Client = ReturnType<typeof getBrowserClient>;

/**
 * packages/database/src/types.ts is regenerated centrally after a migration is applied, so it
 * knows neither `driver_withdrawals.transfer_slip_path`, `drivers.payout_qr_path` nor
 * `attach_driver_payout_slip` yet. Reach them through a narrow structural view of the client
 * rather than widening anything shared.
 */
interface PendingSchemaClient {
  from: (table: string) => {
    select: (columns: string) => {
      in: (column: string, values: string[]) => PromiseLike<{ data: unknown }>;
    };
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string } | null }>;
}

/** What a merchant may attach as proof of transfer. Banking apps hand out both. */
export const PAYOUT_SLIP_MIME = ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'];
export const PAYOUT_SLIP_MAX_BYTES = 10 * 1024 * 1024;

export interface PayoutMedia {
  /** The merchant's transfer slip, in the private payout-slips bucket. */
  slipPath: string | null;
  /** The rider's receiving QR, in the private driver-kyc bucket. */
  qrPath: string | null;
}

function extFor(mime: string): 'png' | 'webp' | 'jpg' | 'pdf' | null {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  if (mime === 'application/pdf') return 'pdf';
  return null;
}

/**
 * The first segment must be the withdrawal id: that is what the payout_slips_* policies and
 * attach_driver_payout_slip's own guard both key on.
 */
export function payoutSlipPath(withdrawalId: string, mime: string, unique: string): string | null {
  const ext = extFor(mime);
  return ext ? `${withdrawalId}/${unique}.${ext}` : null;
}

export function isPdfPath(path: string): boolean {
  return path.toLowerCase().endsWith('.pdf');
}

/**
 * Read the slip and QR for a page of withdrawals. Keyed on the ids the page already resolved
 * rather than fetched alongside them, because the pending query is unbounded and the settled
 * one is not — a single window over the branch would silently miss rows the page is showing.
 *
 * The `drivers` embed comes back null when the rider's approval for this branch is gone, so
 * every field is defaulted rather than assumed.
 */
export async function fetchPayoutMedia(
  supabase: Client,
  withdrawalIds: string[],
): Promise<Map<string, PayoutMedia>> {
  const media = new Map<string, PayoutMedia>();
  if (withdrawalIds.length === 0) return media;

  const { data } = await (supabase as unknown as PendingSchemaClient)
    .from('driver_withdrawals')
    .select('id, transfer_slip_path, drivers(payout_qr_path)')
    .in('id', withdrawalIds);

  for (const raw of Array.isArray(data) ? data : []) {
    const row = raw as Record<string, unknown>;
    const id = row['id'];
    if (typeof id !== 'string') continue;
    const slip = row['transfer_slip_path'];
    const embed = row['drivers'];
    const driver = (Array.isArray(embed) ? embed[0] : embed) as Record<string, unknown> | null;
    const qr = driver?.['payout_qr_path'];
    media.set(id, {
      slipPath: typeof slip === 'string' ? slip : null,
      qrPath: typeof qr === 'string' ? qr : null,
    });
  }
  return media;
}

/**
 * driver_withdrawals has no insert or update policy at all, so the slip is filed through a
 * definer RPC that re-checks "may settle this payout" and writes an audit_logs row.
 */
export async function attachPayoutSlip(
  supabase: Client,
  withdrawalId: string,
  path: string | null,
): Promise<string | null> {
  const { error } = await (supabase as unknown as PendingSchemaClient).rpc(
    'attach_driver_payout_slip',
    { p_withdrawal_id: withdrawalId, p_path: path },
  );
  return error?.message ?? null;
}
