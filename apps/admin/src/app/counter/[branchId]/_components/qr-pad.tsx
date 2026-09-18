'use client';

import * as React from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
import { Button } from '@favornoms/ui';

/** branches.settings.qr_transfer, as the till needs it. */
export interface CounterQrTransfer {
  imageUrl: string;
  accountName: string | null;
  instructions: string | null;
}

/**
 * Taking a QR transfer at the counter.
 *
 * The branch's QR is the merchant's own static image from Branch settings, not a code that
 * carries the amount (the restaurant prices in dollars, and a PromptPay code with an amount in
 * it is baht only). So the amount has to be on screen, large, for the customer to type into
 * their banking app, and the cashier confirms by looking at the app's "paid" screen before
 * tapping Payment received. Nothing is placed until then: Back leaves the cart as it was.
 */
export function QrPad({
  qr,
  amount,
  submitting,
  onReceived,
  onBack,
}: {
  qr: CounterQrTransfer;
  amount: number;
  submitting: boolean;
  onReceived: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('counter');
  // Branch settings uploads the QR to this project's storage, which next/image may resize (the
  // original can be a 3 MB photo). Any other address is shown as it is: next/image refuses a
  // host it is not configured for, and that must not take the payment sheet down with it.
  const optimizable = /^https:\/\/[^/]+\.supabase\.co\//.test(qr.imageUrl);
  return (
    <div className="space-y-4">
      <div className="grid items-center gap-4 sm:grid-cols-[minmax(0,20rem)_1fr]">
        <div className="mx-auto w-full max-w-[20rem] rounded-2xl border border-border bg-white p-3">
          <Image
            src={qr.imageUrl}
            alt={t('pay.qrImageAlt')}
            width={320}
            height={320}
            sizes="20rem"
            unoptimized={!optimizable}
            className="h-auto w-full object-contain"
          />
        </div>
        <div className="space-y-3 text-center sm:text-left">
          <div>
            <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
              {t('pay.qrAmount')}
            </p>
            <p className="font-display text-primary text-5xl font-bold tabular-nums">
              {formatCurrency(amount)}
            </p>
          </div>
          {qr.accountName && (
            <div>
              <p className="text-muted-foreground text-xs font-semibold uppercase tracking-wider">
                {t('pay.qrAccount')}
              </p>
              <p className="text-lg font-semibold">{qr.accountName}</p>
            </div>
          )}
          {qr.instructions && (
            <p className="text-muted-foreground whitespace-pre-line text-sm">{qr.instructions}</p>
          )}
          <p className="bg-muted/60 rounded-xl px-3 py-2 text-sm">{t('pay.qrScanHint')}</p>
        </div>
      </div>

      <div className="flex gap-2">
        <Button variant="ghost" size="xl" onClick={onBack} disabled={submitting}>
          {t('pay.back')}
        </Button>
        <Button variant="gradient" size="xl" fullWidth loading={submitting} onClick={onReceived}>
          {t('pay.qrReceived')}
        </Button>
      </div>
    </div>
  );
}
