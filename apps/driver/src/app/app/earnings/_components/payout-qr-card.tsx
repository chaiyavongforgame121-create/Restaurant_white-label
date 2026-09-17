'use client';

import * as React from 'react';
import { QrCode, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';
import {
  PAYOUT_QR_MAX_BYTES,
  PAYOUT_QR_MIME,
  payoutQrPath,
  setDriverPayoutQr,
} from './payout-media';

interface Props {
  qrPath: string | null;
  onChange: (path: string | null) => void;
  /** A single row instead of a full card, for use inside the request sheet. */
  compact?: boolean;
}

/**
 * The rider's receiving QR. The restaurant sees it beside the withdrawal request, so paying
 * becomes a scan instead of an account number keyed in by hand off a screen.
 *
 * The image lives in the private driver-kyc bucket, so both the preview here and the
 * merchant's copy are short-lived signed URLs rather than public links.
 */
export function PayoutQrCard({ qrPath, onChange, compact = false }: Props) {
  const t = useTranslations('earnings');
  const { driver, refresh } = useDriverSession();
  const [url, setUrl] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Replacing a PNG with a PNG reuses the path, so the effect below needs a nudge to re-sign
  // it — otherwise the rider stares at the image they just replaced.
  const [version, setVersion] = React.useState(0);

  React.useEffect(() => {
    if (!qrPath) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    void getBrowserClient()
      .storage.from('driver-kyc')
      .createSignedUrl(qrPath, 60 * 10)
      .then(({ data }) => {
        if (!cancelled) setUrl(data?.signedUrl ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, [qrPath, version]);

  const upload = async (file: File) => {
    setError(null);
    if (!PAYOUT_QR_MIME.includes(file.type)) {
      setError(t('qr.errors.wrongType'));
      return;
    }
    if (file.size > PAYOUT_QR_MAX_BYTES) {
      setError(t('qr.errors.tooLarge'));
      return;
    }
    const path = payoutQrPath(driver.id, file.type);
    if (!path) return;

    setBusy(true);
    const supabase = getBrowserClient();
    // Storage writes its object metadata to Postgres, so a slow database surfaces here as a
    // timeout and the rider is simply stuck. These failures are transient far more often than
    // not, so retry with backoff before giving up (same as the KYC uploads).
    let lastMessage = '';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { error: upErr } = await supabase.storage
        .from('driver-kyc')
        .upload(path, file, { upsert: true, contentType: file.type });
      if (!upErr) {
        const rpcMessage = await setDriverPayoutQr(supabase, path);
        setBusy(false);
        if (rpcMessage) {
          // The RPC raises bare codes (forbidden, path_not_owned); never put those on screen.
          setError(t('qr.errors.updateFailed'));
          return;
        }
        setVersion((v) => v + 1);
        onChange(path);
        void refresh();
        return;
      }
      lastMessage = upErr.message;
      if (attempt < 2) await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    setBusy(false);
    // Say what to do, not just what broke: "the connection to the database timed out" reads
    // as permanent to a rider, and it almost never is.
    setError(t('qr.errors.busy', { detail: lastMessage }));
  };

  const remove = async () => {
    setBusy(true);
    setError(null);
    // driver-kyc has no DELETE policy, so removing the QR means dropping the pointer; the
    // object stays put and is overwritten by the next upload.
    const message = await setDriverPayoutQr(getBrowserClient(), null);
    setBusy(false);
    if (message) {
      setError(t('qr.errors.updateFailed'));
      return;
    }
    onChange(null);
    void refresh();
  };

  const picker = (
    <label
      className={`focus-ring inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-full px-3 text-xs font-semibold ${
        qrPath ? 'bg-muted text-foreground' : 'bg-primary text-primary-foreground'
      } ${busy ? 'pointer-events-none opacity-60' : ''}`}
    >
      <Upload className="h-3.5 w-3.5" />
      {busy ? t('qr.saving') : qrPath ? t('qr.replace') : t('qr.upload')}
      <input
        type="file"
        accept="image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) void upload(file);
        }}
      />
    </label>
  );

  if (compact) {
    return (
      <div className="border-border bg-muted/40 rounded-xl border p-3">
        <div className="flex items-center gap-3">
          {url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={url}
              alt={t('qr.alt')}
              className="border-border bg-background h-10 w-10 shrink-0 rounded-lg border object-contain"
            />
          ) : (
            <div className="bg-warning/15 text-warning grid h-10 w-10 shrink-0 place-items-center rounded-lg">
              <QrCode className="h-5 w-5" />
            </div>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{t('qr.title')}</p>
            <p className="text-muted-foreground text-xs">
              {qrPath ? t('qr.compactSaved') : t('qr.compactMissing')}
            </p>
          </div>
          {picker}
        </div>
        {error && (
          <p role="alert" className="text-danger mt-2 text-xs">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <Card className="mb-5 p-5">
      <div className="flex items-start gap-3">
        <div className="bg-primary/10 text-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl">
          <QrCode className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-display text-lg font-semibold">{t('qr.title')}</p>
          <p className="text-muted-foreground text-xs">{t('qr.description')}</p>
        </div>
      </div>

      {url && (
        <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 block w-fit">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={t('qr.alt')}
            className="border-border bg-background h-40 w-40 rounded-xl border object-contain"
          />
        </a>
      )}

      <div className="mt-3 flex items-center gap-3">
        {picker}
        {qrPath && (
          <button
            type="button"
            onClick={() => void remove()}
            disabled={busy}
            className="focus-ring text-muted-foreground rounded-full px-2 py-1 text-xs font-semibold disabled:opacity-60"
          >
            {t('qr.remove')}
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="text-danger mt-2 text-xs">
          {error}
        </p>
      )}
    </Card>
  );
}
