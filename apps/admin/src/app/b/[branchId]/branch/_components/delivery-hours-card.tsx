'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bike, Clock, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

/**
 * Delivery hours and who does the delivering.
 *
 * Separate from opening hours on purpose: a kitchen open 09:00–22:00 may only want to
 * run its own deliveries over lunch and dinner. Opening hours still gate the whole
 * shop; these narrow delivery on top.
 *
 * Fail-CLOSED, unlike branch_hours where "no rows" means always open. Delivery hours
 * do nothing until switched on, and once on, a day with no window is a day with no
 * delivery. Copying the fail-open default would invert the merchant's intent the first
 * time they saved an empty day.
 */

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

interface Window {
  opens_at: string;
  closes_at: string;
}
type WeekHours = Record<number, Window[]>;

const INPUT_CLS =
  'h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-primary';

export function DeliveryHoursCard({
  branchId,
  settings,
}: {
  branchId: string;
  settings: Record<string, unknown>;
}) {
  const router = useRouter();
  const [enabled, setEnabled] = React.useState(
    settings?.delivery_hours_enabled === true,
  );
  const [mode, setMode] = React.useState<'platform' | 'self'>(
    (settings?.delivery_mode as 'platform' | 'self') === 'self' ? 'self' : 'platform',
  );
  const [week, setWeek] = React.useState<WeekHours>({});
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase
      .from('branch_delivery_hours')
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

  const setWindow = (day: number, idx: number, patch: Partial<Window>) =>
    setWeek((w) => ({
      ...w,
      [day]: (w[day] ?? []).map((win, i) => (i === idx ? { ...win, ...patch } : win)),
    }));
  const addWindow = (day: number) =>
    setWeek((w) => ({ ...w, [day]: [...(w[day] ?? []), { opens_at: '11:00', closes_at: '14:00' }] }));
  const removeWindow = (day: number, idx: number) =>
    setWeek((w) => ({ ...w, [day]: (w[day] ?? []).filter((_, i) => i !== idx) }));
  const copyToAll = (fromDay: number) => {
    const src = week[fromDay] ?? [];
    setWeek(() => {
      const w: WeekHours = {};
      for (let d = 0; d < 7; d++) w[d] = src.map((win) => ({ ...win }));
      return w;
    });
  };

  const totalWindows = Object.values(week).reduce((n, wins) => n + (wins?.length ?? 0), 0);
  const armedButEmpty = enabled && loaded && totalWindows === 0;

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();

    const windows = Object.entries(week).flatMap(([day, wins]) =>
      (wins ?? [])
        .filter((w) => w.opens_at && w.closes_at)
        .map((w) => ({ day_of_week: Number(day), opens_at: w.opens_at, closes_at: w.closes_at })),
    );

    // Windows first: if the settings write lands and this one fails, the branch is armed
    // with no windows, which is "delivery closed all week".
    const { error: rpcErr } = await supabase.rpc('set_branch_delivery_hours', {
      p_branch_id: branchId,
      p_windows: windows,
    });
    if (rpcErr) {
      setSaving(false);
      setError(rpcErr.message);
      return;
    }

    const { error: upErr } = await supabase
      .from('branches')
      .update({
        settings: { ...settings, delivery_hours_enabled: enabled, delivery_mode: mode },
      })
      .eq('id', branchId)
      .select('id');
    setSaving(false);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Bike className="h-5 w-5 text-primary" /> Delivery
      </h2>

      <div className="mt-4 space-y-3">
        <p className="text-sm font-medium">Who delivers?</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(
            [
              {
                key: 'platform' as const,
                title: 'Favornoms drivers',
                body: 'Orders are offered to nearby riders automatically. They pick up, navigate and mark the order delivered.',
              },
              {
                key: 'self' as const,
                title: 'We deliver ourselves',
                body: 'No rider is called. Your own staff take the order out and mark it picked up and delivered from the Live deliveries screen.',
              },
            ]
          ).map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => setMode(opt.key)}
              className={`focus-ring rounded-xl border p-3 text-left transition ${
                mode === opt.key ? 'border-primary bg-primary/5' : 'border-border bg-card'
              }`}
            >
              <p className="text-sm font-semibold">{opt.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{opt.body}</p>
            </button>
          ))}
        </div>
        {mode === 'self' && (
          <p className="rounded-xl bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
            Customers still see live status updates, but not a map — nothing is reporting a
            position while your own staff are driving.
          </p>
        )}
      </div>

      <div className="mt-6 border-t border-border pt-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="mt-1 h-5 w-5 accent-primary"
          />
          <span>
            <span className="flex items-center gap-1.5 text-sm font-medium">
              <Clock className="h-4 w-4 text-muted-foreground" /> Limit delivery to set hours
            </span>
            <span className="block text-xs text-muted-foreground">
              Off: delivery is available whenever the branch is open. On: only during the
              windows below — customers see them on the menu and cannot check out otherwise.
            </span>
          </span>
        </label>
      </div>

      {enabled && (
        <>
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
                        <Plus className="h-3.5 w-3.5" /> Add window
                      </button>
                    </div>
                  </div>
                  {(week[day]?.length ?? 0) === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">No delivery this day</p>
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

          {armedButEmpty && (
            <p className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
              Delivery hours are switched on but no windows are set — customers cannot place a
              delivery order at all. Add a window, or switch this off.
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save delivery settings
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
    </Card>
  );
}
