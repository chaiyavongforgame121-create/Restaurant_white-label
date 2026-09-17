'use client';

import * as React from 'react';
import { Bike } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { getBrowserClient } from '@favornoms/database/client';
import { listDriverJobHistory, type DriverJobHistoryRow } from '@favornoms/database/queries';
import { branchSubtitle, intlLocaleFor, restaurantLabel, type UiLocale } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

const RANGE_DAYS = [1, 3, 5, 7] as const;

const ALL_RESTAURANTS = 'all';

const money = (n: number) => `$${Number(n).toFixed(2)}`;

type OutcomeKind =
  | 'inProgress'
  | 'delivered'
  | 'youCancelled'
  | 'couldNotDeliver'
  | 'restaurantCancelled'
  | 'reassigned'
  | 'offerExpired'
  | 'youDeclined'
  | 'ended';

type Outcome = { kind: OutcomeKind; variant: 'success' | 'warning' | 'danger' | 'muted' | 'info' };

/**
 * What actually happened to a job, in the rider's words.
 *
 * This screen used to read driver_earnings_ledger, which only ever gets a row on a successful
 * drop-off — so a cancelled job was indistinguishable from a job that never existed, and the
 * empty state ("No completed deliveries…") was the whole truth the screen could tell. It reads
 * delivery_assignments now, where every turn a rider held is recorded with the reason it ended.
 *
 * Returns a stable kind rather than words: the payout decision below compares the kind, and the
 * label is translated only where it is rendered.
 */
function outcomeOf(r: DriverJobHistoryRow): Outcome {
  if (!r.ended_at) return { kind: 'inProgress', variant: 'info' };
  switch (r.end_kind) {
    case 'delivered':
      return { kind: 'delivered', variant: 'success' };
    case 'driver_cancelled':
    case 'driver_cancelled_after_pickup':
      return { kind: 'youCancelled', variant: 'warning' };
    case 'failed_at_door':
      return { kind: 'couldNotDeliver', variant: 'danger' };
    case 'order_cancelled':
      return { kind: 'restaurantCancelled', variant: 'danger' };
    case 'reassigned_by_staff':
    case 'requeued_by_staff':
      return { kind: 'reassigned', variant: 'muted' };
    case 'offer_expired':
      return { kind: 'offerExpired', variant: 'muted' };
    case 'rejected':
      return { kind: 'youDeclined', variant: 'muted' };
    default:
      return r.status === 'delivered'
        ? { kind: 'delivered', variant: 'success' }
        : { kind: 'ended', variant: 'muted' };
  }
}

export default function HistoryPage() {
  const t = useTranslations('history');
  const locale = useLocale() as UiLocale;
  // Not used to filter — driver_job_history resolves the rider from the JWT — but the screen
  // still refetches when the session settles on a different rider row.
  const { driver } = useDriverSession();
  const [rows, setRows] = React.useState<DriverJobHistoryRow[]>([]);
  const [rangeDays, setRangeDays] = React.useState<(typeof RANGE_DAYS)[number]>(7);
  const [branchFilter, setBranchFilter] = React.useState<string>(ALL_RESTAURANTS);
  const [loadFailed, setLoadFailed] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    const supabase = getBrowserClient();
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    void (async () => {
      try {
        const data = await listDriverJobHistory(supabase, { since, limit: 100 });
        if (cancelled) return;
        setRows(data);
        setLoadFailed(false);
      } catch {
        // An empty list would read as "you delivered nothing", which is the wrong answer to
        // give a rider checking whether a job they remember was actually recorded.
        if (!cancelled) setLoadFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driver.id, rangeDays]);

  const labelFor = React.useCallback(
    (r: DriverJobHistoryRow) =>
      restaurantLabel({
        name: r.branch_name,
        restaurant: r.restaurant_name ? { name: r.restaurant_name } : null,
      }),
    [],
  );

  // A rider can be approved at several restaurants, so a mixed list needs a way to answer
  // "what did this one pay me". One restaurant needs no chrome at all.
  const restaurants = React.useMemo(() => {
    const byBranch = new Map<string, string>();
    for (const r of rows) {
      if (!byBranch.has(r.branch_id)) byBranch.set(r.branch_id, labelFor(r).restaurantName);
    }
    return [...byBranch.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows, labelFor]);

  // A restaurant with nothing in the new range drops out of the chips, so a stale selection
  // must fall back rather than leave the rider staring at an empty list they cannot undo.
  const activeBranch = restaurants.some((r) => r.id === branchFilter)
    ? branchFilter
    : ALL_RESTAURANTS;
  const visible =
    activeBranch === ALL_RESTAURANTS ? rows : rows.filter((r) => r.branch_id === activeBranch);
  // Only delivered jobs carry money. Summing every row now that cancelled ones are in the
  // list would leave the header reading as a drop in earnings that never happened.
  const deliveredRows = visible.filter((r) => r.end_kind === 'delivered' || r.status === 'delivered');
  const visibleTotal = deliveredRows.reduce((sum, r) => sum + Number(r.earned ?? 0), 0);

  const activeRestaurantName = restaurants.find((r) => r.id === activeBranch)?.name ?? '';

  const summaryValues = {
    jobs: visible.length,
    delivered: deliveredRows.length,
    total: money(visibleTotal),
    restaurant: activeRestaurantName,
    amount: (chunks: React.ReactNode) => (
      <span className="font-semibold text-foreground">{chunks}</span>
    ),
  };

  return (
    <div className="px-4 pt-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      </header>

      <div className="mb-3 flex gap-2">
        {RANGE_DAYS.map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setRangeDays(d)}
            className={`focus-ring rounded-full px-4 py-1.5 text-sm font-semibold ${
              rangeDays === d
                ? 'bg-primary text-primary-foreground'
                : 'border border-border bg-card text-muted-foreground'
            }`}
          >
            {t('range', { days: d })}
          </button>
        ))}
      </div>

      {restaurants.length > 1 && (
        <div className="mb-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ id: ALL_RESTAURANTS, name: t('allRestaurants') }, ...restaurants].map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => setBranchFilter(r.id)}
              aria-pressed={activeBranch === r.id}
              className={`focus-ring shrink-0 rounded-full px-4 py-1.5 text-sm font-semibold ${
                activeBranch === r.id
                  ? 'bg-primary text-primary-foreground'
                  : 'border border-border bg-card text-muted-foreground'
              }`}
            >
              {r.name}
            </button>
          ))}
        </div>
      )}

      {loadFailed && (
        <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {t('loadError')}
        </p>
      )}

      {visible.length > 0 && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {restaurants.length > 1
            ? activeBranch === ALL_RESTAURANTS
              ? t.rich('summary.all', summaryValues)
              : t.rich('summary.restaurant', summaryValues)
            : t.rich('summary.single', summaryValues)}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {activeBranch === ALL_RESTAURANTS
            ? t('empty.all', { days: rangeDays })
            : t('empty.restaurant', { days: rangeDays, restaurant: activeRestaurantName })}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((r) => {
            const label = labelFor(r);
            const subtitle = branchSubtitle(label);
            const outcome = outcomeOf(r);
            const paid = outcome.kind === 'delivered';
            return (
              <li key={r.assignment_id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Bike className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          {new Date(r.ended_at ?? r.offered_at).toLocaleString(intlLocaleFor(locale))}
                        </p>
                        <span
                          className={`font-display text-lg font-bold ${
                            paid ? 'text-primary' : 'text-muted-foreground'
                          }`}
                        >
                          {paid ? money(Number(r.earned ?? 0)) : t('noPayment')}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-semibold">{label.restaurantName}</p>
                      {subtitle && (
                        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                      )}
                      <p className="font-mono text-xs text-muted-foreground">{r.order_number}</p>
                    </div>
                  </div>
                  <Badge variant={outcome.variant} className="mt-3">
                    {t(`outcome.${outcome.kind}`)}
                  </Badge>
                  {/* The typed reason. Before this the word was written into dispatch_history,
                      which no screen in any of the four apps reads. */}
                  {r.end_reason && (
                    <p className="mt-1.5 text-xs italic text-muted-foreground">“{r.end_reason}”</p>
                  )}
                  {paid && r.ledger_status && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {r.ledger_status === 'paid' ? t('ledger.paid') : t('ledger.awaitingPayout')}
                    </p>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
