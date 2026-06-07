'use client';

import * as React from 'react';
import { CalendarCheck, Clock } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, EmptyState } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

interface ScheduleRow {
  id: string;
  branch_id: string;
  scheduled_period: { lower: string; upper: string } | string;
  status: string;
  notes: string | null;
}

export default function SchedulePage() {
  const { driver } = useDriverSession();
  const [list, setList] = React.useState<ScheduleRow[]>([]);
  const [loading, setLoading] = React.useState(true);

  React.useEffect(() => {
    void (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase
        .from('driver_schedules')
        .select('id, branch_id, scheduled_period, status, notes')
        .eq('driver_id', driver.id)
        .order('id', { ascending: false })
        .limit(20);
      setList((data ?? []) as ScheduleRow[]);
      setLoading(false);
    })();
  }, [driver.id]);

  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">My schedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">Upcoming shifts you&apos;ve signed up for.</p>
      </header>

      {loading ? (
        <p className="text-center text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck className="h-7 w-7" />}
          title="No upcoming shifts"
          description="The dispatcher will publish open shifts here when they're ready."
        />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => {
            const period = typeof s.scheduled_period === 'string'
              ? parseTstzRange(s.scheduled_period)
              : { lower: s.scheduled_period.lower, upper: s.scheduled_period.upper };
            return (
              <li key={s.id}>
                <Card className="flex items-center gap-3 p-4">
                  <Clock className="h-5 w-5 text-muted-foreground" />
                  <div className="flex-1">
                    <p className="font-medium">
                      {new Date(period.lower).toLocaleString()}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      ends {new Date(period.upper).toLocaleString()}
                    </p>
                  </div>
                  <Badge variant={s.status === 'confirmed' ? 'success' : 'muted'}>
                    {s.status}
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

function parseTstzRange(s: string): { lower: string; upper: string } {
  // e.g. ["2026-05-26 09:00:00+00","2026-05-26 17:00:00+00")
  const match = s.match(/\[?"?([^",)]+)"?,"?([^",)]+)"?\)?/);
  return { lower: match?.[1] ?? '', upper: match?.[2] ?? '' };
}
