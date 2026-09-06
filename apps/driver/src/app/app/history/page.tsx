'use client';

import * as React from 'react';
import { Bike } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { listDriverEarnings, type DriverLedgerRow } from '@favornoms/database/queries';
import { branchSubtitle, restaurantLabel } from '@favornoms/shared';
import { Badge, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

const RANGE_DAYS = [1, 3, 5, 7] as const;

const ALL_RESTAURANTS = 'all';

const money = (n: number) => `$${Number(n).toFixed(2)}`;

export default function HistoryPage() {
  const { driver } = useDriverSession();
  const [rows, setRows] = React.useState<DriverLedgerRow[]>([]);
  const [rangeDays, setRangeDays] = React.useState<(typeof RANGE_DAYS)[number]>(7);
  const [branchFilter, setBranchFilter] = React.useState<string>(ALL_RESTAURANTS);
  const [loadError, setLoadError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    const supabase = getBrowserClient();
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    void (async () => {
      try {
        const data = await listDriverEarnings(supabase, driver.id, { since, limit: 50 });
        if (cancelled) return;
        setRows(data);
        setLoadError(null);
      } catch {
        // An empty list would read as "you delivered nothing", which is the wrong answer to
        // give a rider checking whether a job they remember was actually recorded.
        if (!cancelled) setLoadError('Could not load your history — check your signal and reopen.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [driver.id, rangeDays]);

  // A rider can be approved at several restaurants, so a mixed list needs a way to answer
  // "what did this one pay me". One restaurant needs no chrome at all.
  const restaurants = React.useMemo(() => {
    const byBranch = new Map<string, string>();
    for (const r of rows) {
      if (!byBranch.has(r.branch_id)) byBranch.set(r.branch_id, restaurantLabel(r.branch).restaurantName);
    }
    return [...byBranch.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  // A restaurant with nothing in the new range drops out of the chips, so a stale selection
  // must fall back rather than leave the rider staring at an empty list they cannot undo.
  const activeBranch = restaurants.some((r) => r.id === branchFilter)
    ? branchFilter
    : ALL_RESTAURANTS;
  const visible =
    activeBranch === ALL_RESTAURANTS ? rows : rows.filter((r) => r.branch_id === activeBranch);
  const visibleTotal = visible.reduce((sum, r) => sum + Number(r.total ?? 0), 0);

  const rangeLabel = rangeDays === 1 ? 'day' : `${rangeDays} days`;

  return (
    <div className="px-4 pt-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">History</h1>
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
            {d === 1 ? '1 day' : `${d} days`}
          </button>
        ))}
      </div>

      {restaurants.length > 1 && (
        <div className="mb-3 -mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
          {[{ id: ALL_RESTAURANTS, name: 'All restaurants' }, ...restaurants].map((r) => (
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

      {loadError && (
        <p role="alert" className="mb-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {loadError}
        </p>
      )}

      {visible.length > 0 && restaurants.length > 1 && (
        <p role="status" className="mb-3 text-sm text-muted-foreground">
          {visible.length} {visible.length === 1 ? 'delivery' : 'deliveries'} ·{' '}
          <span className="font-semibold text-foreground">{money(visibleTotal)}</span>
          {activeBranch === ALL_RESTAURANTS
            ? ' across every restaurant'
            : ` from ${restaurants.find((r) => r.id === activeBranch)?.name}`}
        </p>
      )}

      {visible.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          {activeBranch === ALL_RESTAURANTS
            ? `No completed deliveries in the last ${rangeLabel}.`
            : `No deliveries for ${restaurants.find((r) => r.id === activeBranch)?.name} in the last ${rangeLabel}.`}
        </p>
      ) : (
        <ul className="space-y-3">
          {visible.map((r) => {
            const label = restaurantLabel(r.branch);
            const subtitle = branchSubtitle(label);
            return (
              <li key={r.id}>
                <Card className="p-4">
                  <div className="flex items-start gap-3">
                    <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                      <Bike className="h-5 w-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium text-muted-foreground">
                          {new Date(r.delivered_at).toLocaleString()}
                        </p>
                        <span className="font-display text-lg font-bold text-primary">
                          {money(Number(r.total ?? 0))}
                        </span>
                      </div>
                      <p className="mt-1 truncate font-semibold">{label.restaurantName}</p>
                      {subtitle && (
                        <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
                      )}
                      <p className="text-xs text-muted-foreground">
                        Base {money(Number(r.base_pay ?? 0))} · Distance{' '}
                        {money(Number(r.distance_pay ?? 0))} · Tip {money(Number(r.tip_net ?? 0))}
                      </p>
                    </div>
                  </div>
                  {/* The restaurant is named above, so the badge only has to say where this
                      one delivery's money currently sits. */}
                  <Badge variant={r.status === 'paid' ? 'success' : 'muted'} className="mt-3">
                    {r.status === 'paid' ? 'Paid' : 'Awaiting payout'}
                  </Badge>
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
