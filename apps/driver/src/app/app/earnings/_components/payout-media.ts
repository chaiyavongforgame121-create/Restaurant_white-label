import type { getBrowserClient } from '@favornoms/database/client';

type BrowserClient = ReturnType<typeof getBrowserClient>;

/**
 * packages/database/src/types.ts is regenerated centrally after a migration is applied, so it
 * does not know about `drivers.payout_qr_path`, `driver_withdrawals.transfer_slip_path` or
 * `set_driver_payout_qr` yet. Reach them through a narrow structural view of the client
 * rather than widening anything shared.
 */
interface PendingSchemaClient {
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string } | null }>;
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string,
      ) => {
        eq: (
          column: string,
          value: string,
        ) => {
          maybeSingle: () => PromiseLike<{ data: Record<string, unknown> | null }>;
        };
      };
    };
  };
}

/** What the rider may hand us as a receiving QR. The QR is rendered, so no PDFs. */
export const PAYOUT_QR_MIME = ['image/png', 'image/jpeg', 'image/webp'];
export const PAYOUT_QR_MAX_BYTES = 10 * 1024 * 1024;

function extFor(mime: string): 'png' | 'webp' | 'jpg' | null {
  if (mime === 'image/png') return 'png';
  if (mime === 'image/webp') return 'webp';
  if (mime === 'image/jpeg') return 'jpg';
  return null;
}

/**
 * One stable name per rider so `upsert` replaces the QR in place: driver-kyc has no DELETE
 * policy, so a uuid-named object would leave an unreachable orphan behind on every change.
 */
export function payoutQrPath(driverId: string, mime: string): string | null {
  const ext = extFor(mime);
  return ext ? `${driverId}/payout_qr.${ext}` : null;
}

/** The rider's own record already selects `*`, so the column is there before the types are. */
export function driverPayoutQrPath(driver: { id: string }): string | null {
  return (driver as { payout_qr_path?: string | null }).payout_qr_path ?? null;
}

/**
 * `drivers_self` is FOR ALL with no column guard, so the column is written through a definer
 * RPC that pins the folder to the caller — a plain update would let a rider point their QR at
 * another rider's folder.
 */
export async function setDriverPayoutQr(
  supabase: BrowserClient,
  path: string | null,
): Promise<string | null> {
  const { error } = await (supabase as unknown as PendingSchemaClient).rpc('set_driver_payout_qr', {
    p_path: path,
  });
  return error?.message ?? null;
}

export async function fetchTransferSlipPath(
  supabase: BrowserClient,
  withdrawalId: string,
  driverId: string,
): Promise<string | null> {
  const { data } = await (supabase as unknown as PendingSchemaClient)
    .from('driver_withdrawals')
    .select('transfer_slip_path')
    .eq('id', withdrawalId)
    .eq('driver_id', driverId)
    .maybeSingle();
  const path = data?.['transfer_slip_path'];
  return typeof path === 'string' ? path : null;
}
