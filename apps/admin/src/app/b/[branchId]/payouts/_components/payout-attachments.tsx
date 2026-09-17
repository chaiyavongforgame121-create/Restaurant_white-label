'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FileText, QrCode, Upload } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  attachPayoutSlip,
  isPdfPath,
  PAYOUT_SLIP_MAX_BYTES,
  PAYOUT_SLIP_MIME,
  payoutSlipPath,
} from './payout-media';

interface Props {
  withdrawalId: string;
  /** The rider's receiving QR, in the private driver-kyc bucket. */
  qrPath: string | null;
  /** The transfer slip already on file, in the private payout-slips bucket. */
  slipPath: string | null;
  /** False once the request is rejected — there is no money behind it to prove. */
  canAttach: boolean;
}

/** attach_driver_payout_slip's error codes → payouts.attachments.errors.<key>. */
const RPC_ERRORS: Record<string, string> = {
  not_authorized: 'notAuthorized',
  not_pending: 'notPending',
  not_found: 'notFound',
};

/**
 * The two halves of paying a rider by transfer: the QR to scan, and the slip that proves the
 * money was sent. Both buckets are private — the QR carries the rider's bank identity and the
 * slip carries the account it landed in — so each is fetched through a short-lived signed URL
 * rather than a public link, the same way diner transfer slips are shown on the orders screen.
 */
export function PayoutAttachments({ withdrawalId, qrPath, slipPath, canAttach }: Props) {
  const t = useTranslations('payouts.attachments');
  const router = useRouter();
  const [qrUrl, setQrUrl] = React.useState<string | null>(null);
  const [slipUrl, setSlipUrl] = React.useState<string | null>(null);
  // router.refresh() is a server round-trip; show the slip the moment it lands instead.
  const [uploadedPath, setUploadedPath] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const currentSlip = uploadedPath ?? slipPath;

  React.useEffect(() => {
    if (!qrPath) {
      setQrUrl(null);
      return;
    }
    let cancelled = false;
    void getBrowserClient()
      .storage.from('driver-kyc')
      .createSignedUrl(qrPath, 60 * 10)
      .then(({ data }) => {
        if (!cancelled) setQrUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrPath]);

  React.useEffect(() => {
    if (!currentSlip) {
      setSlipUrl(null);
      return;
    }
    let cancelled = false;
    void getBrowserClient()
      .storage.from('payout-slips')
      .createSignedUrl(currentSlip, 60 * 10)
      .then(({ data }) => {
        if (!cancelled) setSlipUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [currentSlip]);

  const upload = async (file: File) => {
    setError(null);
    if (!PAYOUT_SLIP_MIME.includes(file.type)) {
      setError(t('errors.fileType'));
      return;
    }
    if (file.size > PAYOUT_SLIP_MAX_BYTES) {
      setError(t('errors.tooLarge'));
      return;
    }
    const path = payoutSlipPath(withdrawalId, file.type, crypto.randomUUID());
    if (!path) return;

    setBusy(true);
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.storage
      .from('payout-slips')
      .upload(path, file, { contentType: file.type, upsert: false });
    if (upErr) {
      setBusy(false);
      console.error('payout slip upload failed', upErr.message);
      setError(t('errors.uploadFailed'));
      return;
    }
    const message = await attachPayoutSlip(supabase, withdrawalId, path);
    setBusy(false);
    if (message) {
      const key = RPC_ERRORS[message];
      if (!key) console.error('attach_driver_payout_slip failed', message);
      setError(t(`errors.${key ?? 'generic'}`));
      return;
    }
    setUploadedPath(path);
    router.refresh();
  };

  return (
    <div className="border-border mt-3 grid gap-3 border-t pt-3 sm:grid-cols-2">
      <div>
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {t('riderQr')}
        </p>
        {qrUrl ? (
          <a
            href={qrUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring mt-1 block w-fit"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={qrUrl}
              alt={t('riderQrAlt')}
              className="border-border bg-background max-h-48 rounded-xl border object-contain"
            />
          </a>
        ) : (
          <p className="text-muted-foreground mt-1 flex items-center gap-1.5 text-sm">
            <QrCode className="h-4 w-4" />
            {qrPath ? t('qrLoadFailed') : t('noQr')}
          </p>
        )}
      </div>

      <div>
        <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
          {t('slip')}
        </p>
        {currentSlip && isPdfPath(currentSlip) ? (
          <a
            href={slipUrl ?? '#'}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring text-primary mt-1 inline-flex items-center gap-1.5 text-sm font-medium underline-offset-2 hover:underline"
          >
            <FileText className="h-4 w-4" /> {t('viewPdf')}
          </a>
        ) : slipUrl ? (
          <a
            href={slipUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring mt-1 block w-fit"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={slipUrl}
              alt={t('slip')}
              className="border-border bg-background max-h-48 rounded-xl border object-contain"
            />
          </a>
        ) : (
          <p className="text-muted-foreground mt-1 text-sm">
            {currentSlip ? t('slipLoadFailed') : t('notAttached')}
          </p>
        )}

        {canAttach && (
          <label
            className={`focus-ring border-border mt-2 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-xs font-semibold ${
              busy ? 'pointer-events-none opacity-60' : 'hover:bg-muted'
            }`}
          >
            <Upload className="h-3.5 w-3.5" />
            {busy ? t('uploading') : currentSlip ? t('replace') : t('attach')}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,application/pdf"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (file) void upload(file);
              }}
            />
          </label>
        )}
        {error && (
          <p role="alert" className="text-danger mt-2 text-xs">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
