'use client';

import * as React from 'react';
import { Bike } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Card } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface Row {
  id: string;
  delivered_at: string;
  base_pay: number;
  distance_pay: number;
  tip_net: number;
  total: number;
  status: string;
  branch: { name: string } | null;
}

const RANGE_DAYS = [1, 3, 5, 7] as const;

export default function HistoryPage() {
  const { driver } = useDriverSession();
  const [rows, setRows] = React.useState<Row[]>([]);
  const [rangeDays, setRangeDays] = React.useState<(typeof RANGE_DAYS)[number]>(7);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const since = new Date(Date.now() - rangeDays * 24 * 60 * 60 * 1000).toISOString();
    void supabase
      .from('driver_earnings_ledger')
      .select('id, delivered_at, base_pay, distance_pay, tip_net, total, status, branch:branches(name)')
      .eq('driver_id', driver.id)
      .gte('delivered_at', since)
      .order('delivered_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setRows((data ?? []) as unknown as Row[]));
  }, [driver.id, rangeDays]);

  return (
    <div className="px-4 pt-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">History</h1>
      </header>
      <div className="mb-4 flex gap-2">
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
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No completed deliveries in the last {rangeDays === 1 ? 'day' : `${rangeDays} days`}.
        </p>
      ) : (
        <ul className="space-y-3">
          {rows.map((r) => (
            <li key={r.id}>
              <Card className="p-4">
                <div className="flex items-start gap-3">
                  <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
                    <Bike className="h-5 w-5" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-muted-foreground">
                        {new Date(r.delivered_at).toLocaleString()}
                      </p>
                      <span className="font-display text-lg font-bold text-primary">
                        ${Number(r.total).toFixed(2)}
                      </span>
                    </div>
                    <p className="mt-1 truncate font-semibold">{r.branch?.name ?? 'Delivery'}</p>
                    <p className="text-xs text-muted-foreground">
                      Base ${Number(r.base_pay).toFixed(2)} · Distance ${Number(r.distance_pay).toFixed(2)} · Tip ${Number(r.tip_net).toFixed(2)}
                    </p>
                  </div>
                </div>
                <Badge variant={r.status === 'paid' ? 'success' : 'muted'} className="mt-3">
                  {r.status === 'paid' ? 'Paid' : 'Awaiting payout'}
                </Badge>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
