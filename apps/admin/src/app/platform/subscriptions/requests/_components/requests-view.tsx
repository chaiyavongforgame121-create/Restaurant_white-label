'use client';

// Merchant package-change queue.
//
// Approving calls decide_billing_request, which applies the package in the same
// transaction that marks the request approved — so the queue can never report
// "approved" for a package that failed to apply.

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { decideBillingRequest, type BillingRequest } from '@favornoms/database/queries';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../../_components/platform-nav';

const money = (n: number) => `$${Number(n ?? 0).toFixed(0)}`;

const FILTERS = [
  { value: 'pending', label: 'Pending' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: '', label: 'All' },
] as const;

export function RequestsView({
  requests,
  status,
}: {
  requests: BillingRequest[];
  status: string;
}) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Package requests</h1>
        <p className="mt-1 text-muted-foreground">
          Merchants who chose a package and are waiting to be switched on.
        </p>
      </header>
      <PlatformNav />

      <div className="mb-4 flex gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.value}
            type="button"
            onClick={() =>
              router.push(`/platform/subscriptions/requests${f.value ? `?status=${f.value}` : ''}`)
            }
            className={`focus-ring rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
              status === f.value
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-muted'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {requests.length === 0 ? (
        <p className="py-16 text-center text-muted-foreground">Nothing here.</p>
      ) : (
        <div className="space-y-4">
          {requests.map((r) => (
            <RequestCard key={r.id} request={r} onError={setError} />
          ))}
        </div>
      )}
    </div>
  );
}

function RequestCard({
  request,
  onError,
}: {
  request: BillingRequest;
  onError: (m: string | null) => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<'approve' | 'reject' | null>(null);
  const [note, setNote] = React.useState('');

  const decide = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'reject');
    onError(null);
    const res = await decideBillingRequest(
      getBrowserClient(),
      request.id,
      approve,
      note.trim() || undefined,
    );
    setBusy(null);
    if (res.ok !== true) {
      onError(res.error ?? 'Could not save that decision.');
      return;
    }
    router.refresh();
  };

  const pending = request.status === 'pending';

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-bold">
            {request.restaurant_name ?? request.restaurant_id}
          </h2>
          <p className="text-xs text-muted-foreground">
            {new Date(request.created_at).toLocaleString('en-US')}
          </p>
        </div>
        <Badge
          variant={
            request.status === 'pending'
              ? 'warning'
              : request.status === 'approved'
                ? 'success'
                : 'muted'
          }
        >
          {request.status}
        </Badge>
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{request.plan_code}</Badge>
        {(request.addons ?? []).map((a) => (
          <Badge key={a} variant="default">
            {a}
          </Badge>
        ))}
        <Badge variant="muted">
          {request.branch_seats} seat{request.branch_seats === 1 ? '' : 's'}
        </Badge>
        <span className="ml-auto font-display text-xl font-bold">
          {money(request.monthly_total)}
          <span className="ml-1 text-sm font-normal text-muted-foreground">/mo</span>
        </span>
      </div>

      {request.note && (
        <p className="mt-3 rounded-xl bg-muted px-3 py-2 text-sm">{request.note}</p>
      )}
      {request.decision_note && (
        <p className="mt-3 text-sm text-muted-foreground">
          Decision note: {request.decision_note}
        </p>
      )}

      {pending && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Note (optional)"
            className="h-10 min-w-[12rem] flex-1 rounded-xl border border-border bg-background px-3 text-sm outline-none focus-visible:border-primary"
          />
          <Button
            size="sm"
            loading={busy === 'approve'}
            disabled={busy !== null}
            onClick={() => decide(true)}
            leftIcon={<Check className="h-4 w-4" />}
          >
            Approve &amp; activate
          </Button>
          <Button
            size="sm"
            variant="ghost"
            loading={busy === 'reject'}
            disabled={busy !== null}
            onClick={() => decide(false)}
            leftIcon={<X className="h-4 w-4" />}
          >
            Reject
          </Button>
        </div>
      )}
    </Card>
  );
}
