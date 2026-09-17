'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Clock,
  FileCheck2,
  RefreshCw,
  ShieldCheck,
  Store,
  Upload,
} from 'lucide-react';
import { Badge, Button, Card, useUiLocale } from '@favornoms/ui';
import { intlLocaleFor, type UiLocale } from '@favornoms/shared';
import { useDriverSession } from '@/components/driver-session';
import { listDriverDocuments, uploadDriverDocument } from './document-storage';
import {
  branchVerification,
  decidedBeforeUpload,
  DOC_KEYS,
  documentsStage,
  lastReceivedAt,
  missingDocKeys,
  STAGE_TONE,
  type DocFile,
  type DocKey,
} from './documents';

const TONE_CLASS = {
  success: 'bg-success/10 text-success',
  warning: 'bg-warning/10 text-warning',
  danger: 'bg-danger/10 text-danger',
  info: 'bg-info/10 text-info',
} as const;

/** Absolute, short and with a time: riders compare "received" against "checked". */
function fmtWhen(ts: string | null, locale: UiLocale): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(intlLocaleFor(locale), {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDay(ts: string | null, locale: UiLocale): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(intlLocaleFor(locale), { day: 'numeric', month: 'short' });
}

export function DocumentsView() {
  const router = useRouter();
  const t = useTranslations('profile');
  const format = useFormatter();
  const locale = useUiLocale();
  const { driver, refresh } = useDriverSession();

  const [docs, setDocs] = React.useState<DocFile[]>([]);
  const [listError, setListError] = React.useState<string | null>(null);
  const [loaded, setLoaded] = React.useState(false);
  const [busyKey, setBusyKey] = React.useState<DocKey | null>(null);
  const [uploadError, setUploadError] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const result = await listDriverDocuments(driver.id, true);
    setDocs(result.docs);
    setListError(result.error);
    setLoaded(true);
  }, [driver.id]);

  React.useEffect(() => {
    void load();
  }, [load]);

  // Neither `drivers` nor `driver_approvals` is in the realtime publication, and the
  // session loads the rider once on mount — so a merchant's decision would otherwise be
  // invisible until the rider force-quit the app. Refetch when the screen comes back to
  // the front or the phone reconnects, the same wake-up the apply screen uses.
  React.useEffect(() => {
    const wake = () => {
      if (document.visibilityState !== 'visible') return;
      void refresh();
      void load();
    };
    document.addEventListener('visibilitychange', wake);
    window.addEventListener('online', wake);
    return () => {
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('online', wake);
    };
  }, [load, refresh]);

  const approvals = React.useMemo(() => driver.approvals ?? [], [driver.approvals]);
  const kycStatus = driver.kyc_status ?? 'pending';
  const receivedAt = lastReceivedAt(docs);
  const stage = documentsStage({
    listFailed: listError !== null,
    docs,
    kycStatus,
    kycVerifiedAt: driver.kyc_verified_at,
  });
  const missing = missingDocKeys(docs);
  const anyCleared = approvals.some((a) => a.status === 'approved');
  const receivedWhen = fmtWhen(receivedAt, locale);
  const verifiedOn = fmtDay(driver.kyc_verified_at, locale);

  const send = async (key: DocKey, file: File) => {
    setBusyKey(key);
    setUploadError(null);
    const message = await uploadDriverDocument(driver.id, key, file);
    if (message) {
      // Say what to do, not just what broke — "connection to the database timed out"
      // reads as permanent to a rider, and it almost never is. Inline rather than
      // alert(), which some mobile browsers swallow entirely.
      setUploadError(t('documents.uploadError', { detail: message }));
    }
    await load();
    await refresh();
    setBusyKey(null);
  };

  return (
    <div className="pb-6">
      <header className="flex items-center gap-2 px-4 pt-safe pt-5">
        <button
          type="button"
          onClick={() => router.back()}
          aria-label={t('documents.back')}
          className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold">{t('documents.title')}</h1>
          <p className="truncate text-sm text-muted-foreground">{t('documents.subtitle')}</p>
        </div>
      </header>

      <section className="mt-4 px-4">
        <Card className={`flex items-start gap-3 p-4 ${TONE_CLASS[STAGE_TONE[stage]]}`}>
          <StageIcon stage={stage} />
          <div className="min-w-0 flex-1 text-sm">
            {stage === 'unreadable' && (
              <>
                <p className="font-display text-base font-semibold">
                  {t('documents.stage.unreadable.title')}
                </p>
                {/* Deliberately not "nothing uploaded": this is our read failing, and a
                    rider told they sent nothing re-sends everything or gives up. */}
                <p className="mt-0.5">{t('documents.stage.unreadable.body')}</p>
                <p className="mt-1 text-xs opacity-80">{listError}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  leftIcon={<RefreshCw className="h-4 w-4" />}
                  onClick={() => void load()}
                >
                  {t('documents.stage.unreadable.retry')}
                </Button>
              </>
            )}
            {stage === 'incomplete' && (
              <>
                <p className="font-display text-base font-semibold">
                  {docs.length === 0
                    ? t('documents.stage.incomplete.titleNone')
                    : t('documents.stage.incomplete.titleSome', {
                        received: docs.length,
                        total: DOC_KEYS.length,
                      })}
                </p>
                <p className="mt-0.5">
                  {t('documents.stage.incomplete.body', {
                    docs: format.list(
                      missing.map((k) => t(`docs.${k}.inline`)),
                      { type: 'conjunction' },
                    ),
                    total: DOC_KEYS.length,
                  })}
                </p>
              </>
            )}
            {stage === 'awaiting' && (
              <>
                <p className="font-display text-base font-semibold">
                  {t('documents.stage.awaiting.title', { total: DOC_KEYS.length })}
                </p>
                <p className="mt-0.5">
                  {receivedAt
                    ? t('documents.stage.awaiting.bodyWithTime', { when: receivedWhen ?? '' })
                    : t('documents.stage.awaiting.body')}
                </p>
              </>
            )}
            {stage === 'rechecking' && (
              <>
                <p className="font-display text-base font-semibold">
                  {t('documents.stage.rechecking.title')}
                </p>
                <p className="mt-0.5">
                  {t('documents.stage.rechecking.body', {
                    when: receivedWhen ?? '',
                    verifiedOn: verifiedOn ?? '',
                  })}
                </p>
              </>
            )}
            {stage === 'verified' && (
              <>
                <p className="font-display text-base font-semibold">
                  {t('documents.stage.verified.title')}
                </p>
                <p className="mt-0.5">
                  {verifiedOn
                    ? t('documents.stage.verified.body', { verifiedOn })
                    : t('documents.stage.verified.bodyNoDate')}
                </p>
              </>
            )}
            {stage === 'changes_needed' && (
              <>
                <p className="font-display text-base font-semibold">
                  {kycStatus === 'suspended'
                    ? t('documents.stage.changesNeeded.titleSuspended')
                    : t('documents.stage.changesNeeded.title')}
                </p>
                <p className="mt-0.5">
                  {receivedAt
                    ? t('documents.stage.changesNeeded.bodyWithTime', { when: receivedWhen ?? '' })
                    : t('documents.stage.changesNeeded.body')}
                </p>
              </>
            )}
          </div>
        </Card>
      </section>

      <section className="mt-4 px-4">
        <h2 className="px-1 pb-2 font-display text-lg font-semibold">
          {t('documents.received.heading')}
        </h2>
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {DOC_KEYS.map((key) => {
              const file = docs.find((d) => d.key === key) ?? null;
              const isPdf = file?.name.toLowerCase().endsWith('.pdf') ?? false;
              const when = fmtWhen(file?.receivedAt ?? null, locale);
              return (
                <li key={key} className="flex items-center gap-3 px-4 py-3">
                  {/* The document itself, not a tick: a rider who photographed the wrong
                      side of a licence can see that without re-sending blind. */}
                  {file?.url && !isPdf ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={file.url}
                      alt={t(`docs.${key}.label`)}
                      className="h-11 w-11 shrink-0 rounded-xl border border-border object-cover"
                    />
                  ) : (
                    <div
                      className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${
                        file ? 'bg-success/15 text-success' : 'bg-muted text-muted-foreground'
                      }`}
                    >
                      {file ? (
                        <CheckCircle2 className="h-5 w-5" />
                      ) : (
                        <FileCheck2 className="h-5 w-5" />
                      )}
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="font-semibold">{t(`docs.${key}.label`)}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {!loaded
                        ? t('documents.received.checking')
                        : listError
                          ? t('documents.received.couldNotCheck')
                          : file
                            ? when
                              ? t('documents.received.receivedAt', { when })
                              : t('documents.received.received')
                            : t(`docs.${key}.hint`)}
                    </p>
                  </div>
                  <label
                    className={`focus-ring inline-flex min-h-touch cursor-pointer items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold ${
                      file
                        ? 'border border-border bg-card text-foreground'
                        : 'bg-primary text-primary-foreground'
                    } ${busyKey === key ? 'pointer-events-none opacity-60' : ''}`}
                  >
                    <Upload className="h-3.5 w-3.5" />
                    {busyKey === key
                      ? t('documents.received.sending')
                      : file
                        ? t('documents.received.replace')
                        : t('documents.received.send')}
                    <input
                      type="file"
                      accept="image/*,.pdf"
                      className="hidden"
                      disabled={busyKey !== null}
                      onChange={(e) => {
                        const picked = e.target.files?.[0];
                        // Clear the input so picking the same file twice still fires.
                        e.target.value = '';
                        if (picked) void send(key, picked);
                      }}
                    />
                  </label>
                </li>
              );
            })}
          </ul>
          {uploadError && (
            <p role="alert" className="bg-danger/10 px-4 py-2.5 text-sm text-danger">
              {uploadError}
            </p>
          )}
        </Card>

        {/* The owner's question, answered where the rider is about to tap Replace. */}
        <p className="mt-2 px-1 text-xs text-muted-foreground">
          {t.rich(anyCleared ? 'documents.replaceNote.cleared' : 'documents.replaceNote.queue', {
            label: (chunks) => <span className="font-semibold text-foreground">{chunks}</span>,
          })}
        </p>
      </section>

      <section className="mt-5 px-4">
        <h2 className="px-1 pb-1 font-display text-lg font-semibold">
          {t('documents.byRestaurant.heading')}
        </h2>
        {/* The one thing about this screen a rider cannot work out for themselves: the
            document check is not per-restaurant. `drivers.kyc_status` is a single column every
            branch reads, so the first restaurant to verify clears the rider everywhere. Only
            the approval below is that restaurant's own. */}
        <p className="px-1 pb-2 text-xs text-muted-foreground">
          {t('documents.byRestaurant.sharedNote')}
        </p>

        {approvals.length === 0 ? (
          <Card className="p-6 text-center">
            <Store className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 font-semibold">{t('documents.byRestaurant.emptyTitle')}</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
              {listError
                ? t('documents.byRestaurant.emptyUnreadable')
                : missing.length > 0
                  ? t('documents.byRestaurant.emptyMissing')
                  : t('documents.byRestaurant.emptyReady')}
            </p>
            <Button
              variant="gradient"
              className="mt-4"
              onClick={() => router.push('/app/apply')}
            >
              {t('documents.byRestaurant.applyCta')}
            </Button>
          </Card>
        ) : (
          <div className="space-y-3">
            {approvals.map((approval) => {
              const state = branchVerification(approval, receivedAt);
              const stale = decidedBeforeUpload(approval.reviewed_at, receivedAt);
              const appliedOn = fmtDay(approval.applied_at, locale) ?? '';
              return (
                <Card key={approval.id} className="p-4">
                  <div className="flex items-start gap-3">
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Store className="h-5 w-5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold">
                        {approval.branch?.restaurant?.name ??
                          approval.branch?.name ??
                          t('documents.byRestaurant.noLongerListed')}
                      </p>
                      {approval.branch && (
                        <p className="truncate text-sm text-muted-foreground">
                          {approval.branch.name}
                        </p>
                      )}
                    </div>
                    <Badge variant={state.variant} className="shrink-0">
                      {t(`documents.branchState.${state.code}.label`)}
                    </Badge>
                  </div>

                  <p className="mt-2 text-xs text-muted-foreground">
                    {t(`documents.branchState.${state.code}.detail`)}
                  </p>

                  <p className="mt-1.5 text-xs text-muted-foreground">
                    {approval.reviewed_at
                      ? t('documents.byRestaurant.appliedReviewed', {
                          applied: appliedOn,
                          reviewed: fmtDay(approval.reviewed_at, locale) ?? '',
                        })
                      : t('documents.byRestaurant.appliedNotReviewed', { applied: appliedOn })}
                  </p>

                  {stale && approval.status !== 'pending' && (
                    <p className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
                      {t('documents.byRestaurant.newerDocument', {
                        when: fmtDay(receivedAt, locale) ?? '',
                      })}
                    </p>
                  )}

                  {/* Typed into the admin reject box, whose placeholder promises it is
                      "Shown to the rider in their app". This is where it is shown. */}
                  {approval.notes && (
                    <p className="mt-2 line-clamp-4 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      {t.rich('documents.byRestaurant.whatTheySaid', {
                        notes: approval.notes,
                        label: (chunks) => (
                          <span className="font-semibold text-foreground">{chunks}</span>
                        ),
                      })}
                    </p>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}

function StageIcon({ stage }: { stage: ReturnType<typeof documentsStage> }) {
  const className = 'mt-0.5 h-6 w-6 shrink-0';
  if (stage === 'verified') return <ShieldCheck className={className} />;
  if (stage === 'awaiting') return <Clock className={className} />;
  if (stage === 'rechecking') return <RefreshCw className={className} />;
  if (stage === 'unreadable' || stage === 'changes_needed')
    return <AlertTriangle className={className} />;
  return <FileCheck2 className={className} />;
}
