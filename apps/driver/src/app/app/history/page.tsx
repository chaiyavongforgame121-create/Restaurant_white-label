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

export default function HistoryPage() {
  const { driver } = useDriverSession();
  const [rows, setRows] = React.useState<Row[]>([]);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase
      .from('driver_earnings_ledger')
      .select('id, delivered_at, base_pay, distance_pay, tip_net, total, status, branch:branches(name)')
      .eq('driver_id', driver.id)
      .order('delivered_at', { ascending: false })
      .limit(50)
      .then(({ data }) => setRows((data ?? []) as unknown as Row[]));
  }, [driver.id]);

  return (
    <div className="px-4 pt-6">
      <header className="mb-5">
        <h1 className="font-display text-2xl font-bold">History</h1>
      </header>
      {rows.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border bg-card p-6 text-center text-sm text-muted-foreground">
          No completed deliveries yet.
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
