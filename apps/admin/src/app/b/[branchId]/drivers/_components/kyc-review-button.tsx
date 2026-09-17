'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { motion, AnimatePresence } from 'framer-motion';
import { Check, FileSearch, X } from 'lucide-react';
import { DEFAULT_UI_LOCALE, isUiLocale } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import {
  decidedBeforeUpload,
  DOC_TYPES,
  formatReceived,
  summariseDriverDocs,
  type DocKey,
} from './driver-docs';

interface Doc {
  key: DocKey;
  /** Key under drivers.docs for the document's name. */
  labelKey: (typeof DOC_TYPES)[number]['labelKey'];
  url: string | null;
  receivedAt: string | null;
}

/** drivers.kyc_status values; anything else is shown as stored. */
const KYC_STATUSES = ['pending', 'verified', 'rejected', 'suspended'] as const;

export function KycReviewButton({
  driverId,
  currentStatus,
  kycVerifiedAt,
  branchReviewedAt,
  branchName,
}: {
  driverId: string;
  currentStatus: string;
  /** When the documents were last verified — the timestamp a replaced file invalidates. */
  kycVerifiedAt: string | null;
  /** When THIS branch last decided on the application, which is a different question. */
  branchReviewedAt: string | null;
  branchName: string;
}) {
  const t = useTranslations('drivers');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [docs, setDocs] = React.useState<Doc[]>([]);
  const [lastReceivedAt, setLastReceivedAt] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [listError, setListError] = React.useState<string | null>(null);

  const when = (ts: string | null) => formatReceived(ts, locale) ?? '';

  const openDialog = async () => {
    setOpen(true);
    setError(null);
    setListError(null);
    const supabase = getBrowserClient();
    const { data, error: lsErr } = await supabase.storage
      .from('driver-kyc')
      .list(driverId, { limit: 50 });
    // A storage denial rendered as three "Not uploaded" rows, which reads as "the rider
    // never sent anything" — the opposite of the truth, and grounds for a wrong rejection.
    if (lsErr) {
      console.error('Could not list the rider’s KYC documents:', lsErr.message);
      setListError(lsErr.message);
    }
    const summary = summariseDriverDocs(data, lsErr?.message ?? null);
    setLastReceivedAt(summary.lastReceivedAt);

    const next: Doc[] = await Promise.all(
      DOC_TYPES.map(async (doc) => {
        const entry = summary.entries.find((e) => e.key === doc.key);
        if (!entry) return { key: doc.key, labelKey: doc.labelKey, url: null, receivedAt: null };
        const { data: signed } = await supabase.storage
          .from('driver-kyc')
          .createSignedUrl(`${driverId}/${entry.name}`, 60 * 10);
        return {
          key: doc.key,
          labelKey: doc.labelKey,
          url: signed?.signedUrl ?? null,
          receivedAt: entry.receivedAt,
        };
      }),
    );
    setDocs(next);
  };

  const setStatus = async (status: 'verified' | 'rejected') => {
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('set_driver_kyc_status', {
      p_driver_id: driverId,
      p_status: status,
    });
    setBusy(false);
    if (rpcErr) {
      // `set_driver_kyc_status` raises 'forbidden' unless the caller holds an active
      // owner/manager staff row. An alert() here was swallowed by some mobile browsers,
      // so a denied review looked like a dead button.
      if (/forbidden/i.test(rpcErr.message)) {
        setError(t('review.forbidden'));
      } else {
        console.error('set_driver_kyc_status failed:', rpcErr.message);
        setError(t('review.saveFailed'));
      }
      return;
    }
    setOpen(false);
    router.refresh();
  };

  const changedSinceVerify = decidedBeforeUpload(kycVerifiedAt, lastReceivedAt);
  const changedSinceDecision = decidedBeforeUpload(branchReviewedAt, lastReceivedAt);

  const statusLabel = (KYC_STATUSES as readonly string[]).includes(currentStatus)
    ? t(`kycStatus.${currentStatus}`)
    : currentStatus;

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={<FileSearch className="h-4 w-4" />}
        onClick={openDialog}
      >
        {t('review.button')}
      </Button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-[120] grid place-items-center bg-black/60 p-4 backdrop-blur-sm"
          >
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              exit={{ y: 10, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-card p-5 shadow-2xl"
            >
              <header className="mb-4 flex items-center justify-between">
                <div>
                  <h2 className="font-display text-xl font-bold">{t('review.title')}</h2>
                  <p className="text-xs text-muted-foreground">
                    {kycVerifiedAt
                      ? t('review.currentStatusVerified', {
                          status: statusLabel,
                          date: when(kycVerifiedAt),
                        })
                      : t('review.currentStatus', { status: statusLabel })}
                  </p>
                </div>
                <button
                  onClick={() => setOpen(false)}
                  className="focus-ring rounded-full p-1.5 hover:bg-muted"
                >
                  <X className="h-5 w-5" />
                </button>
              </header>

              {/* Verify/Reject writes drivers.kyc_status, which is ONE column every branch
                  reads — the button does not scope to this branch, and a merchant who
                  assumes it does will reject a rider out of every restaurant at once. */}
              <p className="mb-4 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
                {t('review.sharedWarning', { branch: branchName })}
              </p>

              {(changedSinceVerify || changedSinceDecision) && (
                <p className="mb-4 rounded-xl bg-warning/10 px-3 py-2 text-sm font-semibold text-warning">
                  {changedSinceVerify
                    ? t('review.replacedAfterVerify', {
                        replaced: when(lastReceivedAt),
                        verified: when(kycVerifiedAt),
                      })
                    : t('review.replacedAfterDecision', {
                        replaced: when(lastReceivedAt),
                        decided: when(branchReviewedAt),
                      })}
                </p>
              )}

              <ul className="space-y-3">
                {docs.map((d) => {
                  const label = t(`docs.${d.labelKey}`);
                  return (
                    <li key={d.key}>
                      <Card className="overflow-hidden p-0">
                        <header className="flex items-center justify-between gap-3 bg-muted/40 px-4 py-2">
                          <div className="min-w-0">
                            <p className="font-semibold">{label}</p>
                            <p className="truncate text-xs text-muted-foreground">
                              {d.receivedAt
                                ? t('review.receivedAt', { date: when(d.receivedAt) })
                                : t('review.nothingReceived')}
                            </p>
                          </div>
                          {d.url ? (
                            <a
                              href={d.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="shrink-0 text-xs font-semibold text-primary"
                            >
                              {t('review.openFullSize')}
                            </a>
                          ) : (
                            <span className="shrink-0 text-xs text-muted-foreground">
                              {t('review.notUploaded')}
                            </span>
                          )}
                        </header>
                        {d.url ? (
                          d.url.endsWith('.pdf') ? (
                            <iframe src={d.url} className="h-64 w-full bg-muted" title={label} />
                          ) : (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={d.url}
                              alt={label}
                              className="max-h-72 w-full bg-muted object-contain"
                            />
                          )
                        ) : (
                          <div className="grid h-32 place-items-center text-sm text-muted-foreground">
                            {t('review.awaitingUpload')}
                          </div>
                        )}
                      </Card>
                    </li>
                  );
                })}
              </ul>

              {listError && (
                <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                  {t('review.listError')}
                </p>
              )}
              {error && (
                <p className="mt-3 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
              )}

              {/* Rejecting sets the shared flag but writes nothing the rider can read, so
                  point the merchant at the one field that does reach them. */}
              <p className="mt-4 text-xs text-muted-foreground">{t('review.rejectHint')}</p>

              <footer className="mt-3 flex gap-2">
                <Button
                  variant="outline"
                  leftIcon={<X className="h-4 w-4" />}
                  onClick={() => setStatus('rejected')}
                  loading={busy}
                  fullWidth
                >
                  {t('review.reject')}
                </Button>
                <Button
                  variant="gradient"
                  leftIcon={<Check className="h-4 w-4" />}
                  onClick={() => setStatus('verified')}
                  loading={busy}
                  fullWidth
                >
                  {t('review.verify')}
                </Button>
              </footer>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
