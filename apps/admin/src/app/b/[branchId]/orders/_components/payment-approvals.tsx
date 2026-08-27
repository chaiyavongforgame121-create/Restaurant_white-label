'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, QrCode, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

export interface PendingTransfer {
  payment_id: string;
  order_id: string;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
  amount: number;
  proof_path: string | null;
  submitted_at: string | null;
}

/**
 * QR-transfer slips waiting on the merchant. Rendered above the order table rather than as
 * a per-row button: the order sits in `pending` and cannot move until this is decided, so
 * it is the most time-critical thing on the screen.
 *
 * Slips live in the PRIVATE `payment-proofs` bucket — they carry the payer's name and
 * account number — so each one is fetched through a short-lived signed URL rather than a
 * public link.
 */
export function PaymentApprovals({
  branchId: _branchId,
  pending,
}: {
  branchId: string;
  pending: PendingTransfer[];
}) {
  const router = useRouter();
  const [urls, setUrls] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [rejecting, setRejecting] = React.useState<string | null>(null);
  const [note, setNote] = React.useState('');

  React.useEffect(() => {
    let cancelled = false;
    const paths = pending.map((p) => p.proof_path).filter((p): p is string => !!p);
    if (paths.length === 0) return;
    const supabase = getBrowserClient();
    void supabase.storage
      .from('payment-proofs')
      .createSignedUrls(paths, 60 * 10)
      .then(({ data }) => {
        if (cancelled || !data) return;
        const next: Record<string, string> = {};
        for (const row of data) {
          if (row.path && row.signedUrl) next[row.path] = row.signedUrl;
        }
        setUrls(next);
      });
    return () => {
      cancelled = true;
    };
  }, [pending]);

  const decide = async (paymentId: string, approve: boolean, reason: string | null) => {
    setBusy(paymentId);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('decide_payment_proof', {
      p_payment_id: paymentId,
      p_approve: approve,
      p_note: reason,
    });
    setBusy(null);
    if (rpcErr) {
      setError(
        /forbidden/i.test(rpcErr.message)
          ? 'Only an owner or manager can approve payments.'
          : rpcErr.message,
      );
      return;
    }
    setRejecting(null);
    setNote('');
    router.refresh();
  };

  if (pending.length === 0) return null;

  return (
    <Card className="mb-4 border-warning/40 bg-warning/5 p-4">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <QrCode className="h-5 w-5 text-warning" />
        {pending.length} transfer{pending.length === 1 ? '' : 's'} waiting for you
      </h2>
      <p className="mt-1 text-sm text-muted-foreground">
        These orders are paid by QR transfer and will not reach the kitchen until you confirm
        the money arrived.
      </p>

      <ul className="mt-3 space-y-3">
        {pending.map((p) => {
          const url = p.proof_path ? urls[p.proof_path] : undefined;
          return (
            <li key={p.payment_id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="font-mono text-xs text-muted-foreground">#{p.order_number}</p>
                  <p className="font-semibold">
                    ${Number(p.amount).toFixed(2)} · {p.customer_name ?? 'Customer'}
                  </p>
                  {p.customer_phone && (
                    <p className="text-sm text-muted-foreground">{p.customer_phone}</p>
                  )}
                  {p.submitted_at && (
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      Slip uploaded {new Date(p.submitted_at).toLocaleString('en-US')}
                    </p>
                  )}
                </div>
                {rejecting === p.payment_id ? (
                  <div className="w-full max-w-xs">
                    <label
                      htmlFor={`pay-note-${p.payment_id}`}
                      className="text-xs font-semibold"
                    >
                      What was wrong?
                    </label>
                    <textarea
                      id={`pay-note-${p.payment_id}`}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={2}
                      maxLength={280}
                      placeholder="Shown to the customer so they can fix it"
                      className="focus-ring mt-1 w-full resize-none rounded-lg border border-border bg-card px-2 py-1.5 text-sm"
                    />
                    <div className="mt-2 flex justify-end gap-2">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setRejecting(null);
                          setNote('');
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        loading={busy === p.payment_id}
                        disabled={note.trim().length === 0}
                        onClick={() => void decide(p.payment_id, false, note.trim())}
                      >
                        Confirm reject
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy !== null}
                      leftIcon={<X className="h-4 w-4" />}
                      onClick={() => setRejecting(p.payment_id)}
                    >
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      loading={busy === p.payment_id}
                      disabled={busy !== null}
                      leftIcon={<Check className="h-4 w-4" />}
                      onClick={() => void decide(p.payment_id, true, null)}
                    >
                      Approve
                    </Button>
                  </div>
                )}
              </div>

              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer" className="mt-3 block">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={url}
                    alt={`Transfer slip for order ${p.order_number}`}
                    className="max-h-64 w-full rounded-lg border border-border bg-muted object-contain"
                  />
                </a>
              ) : (
                <div className="mt-3 grid h-24 place-items-center rounded-lg bg-muted text-sm text-muted-foreground">
                  {p.proof_path ? 'Loading slip…' : 'No slip uploaded yet'}
                </div>
              )}
            </li>
          );
        })}
      </ul>

      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Card>
  );
}
