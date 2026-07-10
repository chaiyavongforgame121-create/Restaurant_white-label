'use client';

import * as React from 'react';
import { CalendarCheck, Clock } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Card, EmptyState } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

// driver_schedules stores each shift as start_at/end_at (timestamptz) — NOT a
// tstzrange. The apply_driver_schedules cron reads the same columns to auto-online
// the driver for that branch during the window.
interface ScheduleRow {
  id: string;
  branch_id: string;
  start_at: string;
  end_at: string;
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
        .select('id, branch_id, start_at, end_at, status, notes')
        .eq('driver_id', driver.id)
        .gte('end_at', new Date().toISOString())
        .order('start_at', { ascending: true })
        .limit(20);
      setList((data ?? []) as ScheduleRow[]);
      setLoading(false);
    })();
  }, [driver.id]);

  return (
    <div className="container max-w-xl py-6">
      <header className="mb-5 px-1">
        <h1 className="font-display text-2xl font-bold">My schedule</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Upcoming shifts — you go online automatically at each restaurant during its window.
        </p>
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
          {list.map((s) => (
            <li key={s.id}>
              <Card className="flex items-center gap-3 p-4">
                <Clock className="h-5 w-5 text-muted-foreground" />
                <div className="flex-1">
                  <p className="font-medium">{new Date(s.start_at).toLocaleString()}</p>
                  <p className="text-xs text-muted-foreground">
                    ends {new Date(s.end_at).toLocaleString()}
                  </p>
                </div>
                <Badge variant={s.status === 'confirmed' ? 'success' : 'muted'}>{s.status}</Badge>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
