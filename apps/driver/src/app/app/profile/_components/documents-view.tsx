'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
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
import { Badge, Button, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';
import { listDriverDocuments, uploadDriverDocument } from './document-storage';
import {
  branchVerification,
  decidedBeforeUpload,
  DOC_HINT,
  DOC_KEYS,
  DOC_LABEL,
  documentsStage,
  lastReceivedAt,
  missingDocKeys,
  SHARED_CHECK_NOTE,
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
function fmtWhen(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function fmtDay(ts: string | null): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function DocumentsView() {
  const router = useRouter();
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

  const send = async (key: DocKey, file: File) => {
    setBusyKey(key);
    setUploadError(null);
    const message = await uploadDriverDocument(driver.id, key, file);
    if (message) {
      // Say what to do, not just what broke — "connection to the database timed out"
      // reads as permanent to a rider, and it almost never is. Inline rather than
      // alert(), which some mobile browsers swallow entirely.
      setUploadError(
        `Couldn't send that document — the server is busy. Wait a moment and try again. (${message})`,
      );
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
          aria-label="Back"
          className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full text-muted-foreground hover:bg-muted"
        >
          <ChevronLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0">
          <h1 className="font-display text-2xl font-bold">Documents</h1>
          <p className="truncate text-sm text-muted-foreground">
            What we have, and where each restaurant has got to
          </p>
        </div>
      </header>

      <section className="mt-4 px-4">
        <Card className={`flex items-start gap-3 p-4 ${TONE_CLASS[STAGE_TONE[stage]]}`}>
          <StageIcon stage={stage} />
          <div className="min-w-0 flex-1 text-sm">
            {stage === 'unreadable' && (
              <>
                <p className="font-display text-base font-semibold">
                  We couldn&apos;t read your documents
                </p>
                {/* Deliberately not "nothing uploaded": this is our read failing, and a
                    rider told they sent nothing re-sends everything or gives up. */}
                <p className="mt-0.5">
                  This is our side, not yours. Anything you already sent is still there —
                  try again in a moment.
                </p>
                <p className="mt-1 text-xs opacity-80">{listError}</p>
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-2"
                  leftIcon={<RefreshCw className="h-4 w-4" />}
                  onClick={() => void load()}
                >
                  Try again
                </Button>
              </>
            )}
            {stage === 'incomplete' && (
              <>
                <p className="font-display text-base font-semibold">
                  {docs.length === 0
                    ? 'Nothing received yet'
                    : `${docs.length} of ${DOC_KEYS.length} received`}
                </p>
                <p className="mt-0.5">
                  Still to send: {missing.map((k) => DOC_LABEL[k].toLowerCase()).join(', ')}.
                  Restaurants cannot see you until all {DOC_KEYS.length} are in.
                </p>
              </>
            )}
            {stage === 'awaiting' && (
              <>
                <p className="font-display text-base font-semibold">
                  All {DOC_KEYS.length} documents received
                </p>
                <p className="mt-0.5">
                  Nothing more to do — they are waiting to be verified.
                  {receivedAt && ` Last one arrived ${fmtWhen(receivedAt)}.`}
                </p>
              </>
            )}
            {stage === 'rechecking' && (
              <>
                <p className="font-display text-base font-semibold">Waiting to be checked again</p>
                <p className="mt-0.5">
                  You replaced a document {fmtWhen(receivedAt)}, after it was verified on{' '}
                  {fmtDay(driver.kyc_verified_at)}. The new file has been received and is
                  waiting for someone to look at it.
                </p>
              </>
            )}
            {stage === 'verified' && (
              <>
                <p className="font-display text-base font-semibold">Documents verified</p>
                <p className="mt-0.5">
                  Verified {fmtDay(driver.kyc_verified_at) ?? 'already'}. Each restaurant
                  still approves you separately — see below.
                </p>
              </>
            )}
            {stage === 'changes_needed' && (
              <>
                <p className="font-display text-base font-semibold">
                  {kycStatus === 'suspended' ? 'Your documents are suspended' : 'A document needs changing'}
                </p>
                <p className="mt-0.5">
                  Replace whichever document is wrong below.
                  {receivedAt && ` You last sent one ${fmtWhen(receivedAt)}.`} Replacing a
                  file does not restart the check on its own — tell the restaurant it is
                  ready to look at again.
                </p>
              </>
            )}
          </div>
        </Card>
      </section>

      <section className="mt-4 px-4">
        <h2 className="px-1 pb-2 font-display text-lg font-semibold">What we have received</h2>
        <Card className="overflow-hidden p-0">
          <ul className="divide-y divide-border">
            {DOC_KEYS.map((key) => {
              const file = docs.find((d) => d.key === key) ?? null;
              const isPdf = file?.name.toLowerCase().endsWith('.pdf') ?? false;
              const when = fmtWhen(file?.receivedAt ?? null);
              return (
                <li key={key} className="flex items-center gap-3 px-4 py-3">
                  {/* The document itself, not a tick: a rider who photographed the wrong
                      side of a licence can see that without re-sending blind. */}
                  {file?.url && !isPdf ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={file.url}
                      alt={DOC_LABEL[key]}
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
                    <p className="font-semibold">{DOC_LABEL[key]}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {!loaded
                        ? 'Checking…'
                        : listError
                          ? 'Could not check'
                          : file
                            ? when
                              ? `Received ${when}`
                              : 'Received'
                            : DOC_HINT[key]}
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
                    {busyKey === key ? 'Sending…' : file ? 'Replace' : 'Send'}
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
          <span className="font-semibold text-foreground">Replacing a document: </span>
          the new file is received straight away and replaces the old one, but a check that
          already happened is not undone automatically.
          {anyCleared
            ? ' You keep delivering for the restaurants that have already approved you, and their screen flags that your paperwork changed after they looked at it.'
            : ' It goes back into the queue to be verified.'}
        </p>
      </section>

      <section className="mt-5 px-4">
        <h2 className="px-1 pb-1 font-display text-lg font-semibold">Verification by restaurant</h2>
        <p className="px-1 pb-2 text-xs text-muted-foreground">{SHARED_CHECK_NOTE}</p>

        {approvals.length === 0 ? (
          <Card className="p-6 text-center">
            <Store className="mx-auto h-8 w-8 text-muted-foreground" />
            <p className="mt-2 font-semibold">No restaurant is reviewing you yet</p>
            <p className="mx-auto mt-1 max-w-xs text-sm text-muted-foreground">
              {listError
                ? 'We could not read your documents just now, so we cannot tell you what is left to send.'
                : missing.length > 0
                  ? 'Send the remaining documents first — you can apply as soon as all three are in.'
                  : 'Your documents are in. Apply to a restaurant and they will review you.'}
            </p>
            <Button
              variant="gradient"
              className="mt-4"
              onClick={() => router.push('/app/apply')}
            >
              Apply to a restaurant
            </Button>
          </Card>
        ) : (
          <div className="space-y-3">
            {approvals.map((approval) => {
              const state = branchVerification(approval, receivedAt);
              const stale = decidedBeforeUpload(approval.reviewed_at, receivedAt);
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
                          'This restaurant is no longer listed'}
                      </p>
                      {approval.branch && (
                        <p className="truncate text-sm text-muted-foreground">
                          {approval.branch.name}
                        </p>
                      )}
                    </div>
                    <Badge variant={state.variant} className="shrink-0">
                      {state.label}
                    </Badge>
                  </div>

                  <p className="mt-2 text-xs text-muted-foreground">{state.detail}</p>

                  <p className="mt-1.5 text-xs text-muted-foreground">
                    Applied {fmtDay(approval.applied_at)}
                    {approval.reviewed_at
                      ? ` · they looked ${fmtDay(approval.reviewed_at)}`
                      : ' · not looked at yet'}
                  </p>

                  {stale && approval.status !== 'pending' && (
                    <p className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-xs text-warning">
                      You sent a newer document on {fmtDay(receivedAt)}, after this decision.
                    </p>
                  )}

                  {/* Typed into the admin reject box, whose placeholder promises it is
                      "Shown to the rider in their app". This is where it is shown. */}
                  {approval.notes && (
                    <p className="mt-2 line-clamp-4 rounded-xl bg-muted/60 px-3 py-2 text-xs text-muted-foreground">
                      <span className="font-semibold text-foreground">What they said: </span>
                      {approval.notes}
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
