'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';
import { formatPhone } from '@favornoms/shared';

interface AssignmentReason {
  delivery_id: string;
  seq: number;
  end_kind: string | null;
  end_reason: string | null;
}

// Failed deliveries needing a staff decision: re-dispatch (sends it back into
// the driver pool via requeue_failed_delivery) or handle offline (refund/void
// through the normal order actions).
//
// requeue_failed_delivery nulls deliveries.failed_reason — the job is being retried and the
// board must stop calling it failed — so this panel used to be the last screen that could
// explain a failure, and only until somebody pressed the button. The reason lives on the rider
// turn now (delivery_assignments.end_reason, 20260908111000), which is read here so a row that
// has been through a re-dispatch still says what happened the first time.

export interface DeliveryIssue {
  id: string;
  order_id: string;
  failed_reason: string | null;
  failed_photo_url: string | null;
  order_number: string;
  customer_name: string | null;
  customer_phone: string | null;
}

export function DeliveryIssues({ issues }: { issues: DeliveryIssue[] }) {
  const router = useRouter();
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reasons, setReasons] = React.useState<Map<string, AssignmentReason>>(new Map());

  // Serialised so the effect keys off the SET of deliveries on screen, not the array identity
  // the parent server component rebuilds on every refresh.
  const issueKey = issues.map((d) => d.id).join(',');

  React.useEffect(() => {
    if (!issueKey) return;
    let cancelled = false;
    const supabase = getBrowserClient();
    void supabase
      .from('delivery_assignments')
      .select('delivery_id, seq, end_kind, end_reason')
      .in('delivery_id', issueKey.split(','))
      .not('end_reason', 'is', null)
      .order('seq', { ascending: true })
      .then(({ data }) => {
        if (cancelled || !data) return;
        // Ascending seq, so the last write per delivery is the newest turn that explained itself.
        const next = new Map<string, AssignmentReason>();
        for (const row of data as unknown as AssignmentReason[]) next.set(row.delivery_id, row);
        setReasons(next);
      });
    return () => {
      cancelled = true;
    };
  }, [issueKey]);

  if (issues.length === 0) return null;

  const requeue = async (deliveryId: string) => {
    setBusy(deliveryId);
    setError(null);
    const supabase = getBrowserClient();
    const { error: err } = await supabase.rpc('requeue_failed_delivery', {
      p_delivery_id: deliveryId,
    } as never);
    setBusy(null);
    if (err) {
      setError(err.message);
      return;
    }
    router.refresh();
  };

  return (
    <Card className="mb-4 border-danger/30 bg-danger/5 p-4">
      <h2 className="flex items-center gap-2 font-display text-base font-bold text-danger">
        <AlertTriangle className="h-4 w-4" /> Delivery issues ({issues.length})
      </h2>
      <p className="mt-0.5 text-xs text-muted-foreground">
        Failed deliveries — re-dispatch to find another driver, or refund via the order row.
      </p>
      <ul className="mt-3 space-y-2">
        {issues.map((d) => (
          <li
            key={d.id}
            className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-card p-3"
          >
            <div className="min-w-0">
              <p className="font-mono text-xs text-muted-foreground">{d.order_number}</p>
              <p className="text-sm font-semibold">
                {d.customer_name ?? 'Customer'}
                {d.customer_phone ? ` · ${formatPhone(d.customer_phone)}` : ''}
              </p>
              <p className="text-xs text-danger">
                {d.failed_reason ?? reasons.get(d.id)?.end_reason ?? 'No reason recorded'}
                {d.failed_photo_url && (
                  <>
                    {' · '}
                    <a
                      href={d.failed_photo_url}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      photo
                    </a>
                  </>
                )}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              leftIcon={<RefreshCw className="h-3.5 w-3.5" />}
              onClick={() => requeue(d.id)}
              loading={busy === d.id}
            >
              Re-dispatch
            </Button>
          </li>
        ))}
      </ul>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </Card>
  );
}
