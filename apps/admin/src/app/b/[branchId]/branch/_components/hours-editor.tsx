'use client';

import * as React from 'react';
import { Clock, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Weekly opening hours (branch_hours). No rows = always open (back-compat).
// A window whose close time is ≤ its open time crosses midnight (e.g. 22:00–02:00).

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Window {
  opens_at: string; // 'HH:MM'
  closes_at: string;
}

type WeekHours = Record<number, Window[]>;

const INPUT_CLS =
  'h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-primary';

export function HoursEditor({ branchId }: { branchId: string }) {
  const [week, setWeek] = React.useState<WeekHours>({});
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase
      .from('branch_hours')
      .select('day_of_week, opens_at, closes_at')
      .eq('branch_id', branchId)
      .order('day_of_week')
      .order('opens_at')
      .then(({ data }) => {
        const w: WeekHours = {};
        for (const row of data ?? []) {
          const d = row.day_of_week as number;
          (w[d] ??= []).push({
            opens_at: String(row.opens_at).slice(0, 5),
            closes_at: String(row.closes_at).slice(0, 5),
          });
        }
        setWeek(w);
        setLoaded(true);
      });
  }, [branchId]);

  const setWindow = (day: number, idx: number, patch: Partial<Window>) => {
    setWeek((w) => ({
      ...w,
      [day]: (w[day] ?? []).map((win, i) => (i === idx ? { ...win, ...patch } : win)),
    }));
  };
  const addWindow = (day: number) => {
    setWeek((w) => ({ ...w, [day]: [...(w[day] ?? []), { opens_at: '10:00', closes_at: '21:00' }] }));
  };
  const removeWindow = (day: number, idx: number) => {
    setWeek((w) => ({ ...w, [day]: (w[day] ?? []).filter((_, i) => i !== idx) }));
  };
  const copyToAll = (fromDay: number) => {
    const src = week[fromDay] ?? [];
    setWeek(() => {
      const w: WeekHours = {};
      for (let d = 0; d < 7; d++) w[d] = src.map((win) => ({ ...win }));
      return w;
    });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const windows = Object.entries(week).flatMap(([day, wins]) =>
      (wins ?? [])
        .filter((w) => w.opens_at && w.closes_at)
        .map((w) => ({
          day_of_week: Number(day),
          opens_at: w.opens_at,
          closes_at: w.closes_at,
        })),
    );
    // Atomic replace-all via RPC: the delete+insert run in one transaction server-side, so a
    // failed insert can no longer leave the branch with zero rows (which means "always open").
    const { error: rpcErr } = await (
      supabase as unknown as {
        rpc: (fn: string, args: Record<string, unknown>) => Promise<{ error: { message: string } | null }>;
      }
    ).rpc('set_branch_hours', { p_branch_id: branchId, p_windows: windows });
    setSaving(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    setSavedAt(Date.now());
  };

  const totalWindows = Object.values(week).reduce((n, wins) => n + (wins?.length ?? 0), 0);

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Clock className="h-5 w-5 text-primary" /> Opening hours
      </h2>
      <p className="text-sm text-muted-foreground">
        Ordering opens and closes automatically. No hours set = always open. A window ending at or
        before its start time crosses midnight (late-night service).
      </p>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
      ) : (
        <div className="mt-4 space-y-3">
          {DAYS.map((name, day) => (
            <div key={day} className="rounded-xl border border-border p-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-semibold">{name}</p>
                <div className="flex items-center gap-2">
                  {(week[day]?.length ?? 0) > 0 && (
                    <button
                      type="button"
                      onClick={() => copyToAll(day)}
                      className="focus-ring text-xs text-muted-foreground underline"
                    >
                      Copy to all days
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => addWindow(day)}
                    className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add hours
                  </button>
                </div>
              </div>
              {(week[day]?.length ?? 0) === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">Closed all day</p>
              ) : (
                <div className="mt-2 space-y-2">
                  {(week[day] ?? []).map((win, idx) => (
                    <div key={idx} className="flex items-center gap-2">
                      <input
                        type="time"
                        value={win.opens_at}
                        onChange={(e) => setWindow(day, idx, { opens_at: e.target.value })}
                        className={INPUT_CLS}
                      />
                      <span className="text-xs text-muted-foreground">to</span>
                      <input
                        type="time"
                        value={win.closes_at}
                        onChange={(e) => setWindow(day, idx, { closes_at: e.target.value })}
                        className={INPUT_CLS}
                      />
                      {win.closes_at <= win.opens_at && (
                        <span className="text-xs text-muted-foreground">(overnight)</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeWindow(day, idx)}
                        className="focus-ring ml-auto text-muted-foreground hover:text-danger"
                        aria-label="Remove window"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save hours
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
        {loaded && totalWindows === 0 && (
          <span className="text-xs text-muted-foreground">Currently: always open</span>
        )}
      </div>
    </Card>
  );
}
