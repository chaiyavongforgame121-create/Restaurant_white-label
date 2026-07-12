'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck, Clock, Plus, Store, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  createDriverSchedules,
  deleteDriverSchedule,
  getDriverSchedules,
  type DriverScheduleRow,
} from '@favornoms/database/queries';
import { Badge, Button, Card, EmptyState, cn } from '@favornoms/ui';
import { useDriverSession } from '@/components/driver-session';

// Drivers set their own open/close windows per approved restaurant. Each window
// is a concrete driver_schedules row (start_at/end_at timestamptz). The pg_cron
// job `apply_driver_schedules` brings the branch online at start_at and offline
// at end_at (mode='scheduled'), yielding to any manual toggle. RLS keeps a driver
// to their own rows, so we read/write the table directly.
//
// Extracted so both /app/schedule and the home "Go online" sheet reuse it.

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-card px-3 text-base outline-none transition-colors focus-visible:border-primary';

const WEEKDAYS = [
  { i: 0, label: 'S', full: 'Sun' },
  { i: 1, label: 'M', full: 'Mon' },
  { i: 2, label: 'T', full: 'Tue' },
  { i: 3, label: 'W', full: 'Wed' },
  { i: 4, label: 'T', full: 'Thu' },
  { i: 5, label: 'F', full: 'Fri' },
  { i: 6, label: 'S', full: 'Sat' },
] as const;

function parseHM(t: string): [number, number] {
  const [h, m] = t.split(':');
  return [Number(h ?? 0), Number(m ?? 0)];
}

/** Build concrete windows for the selected weekdays across the next `daysAhead`
 *  days, at the given local open/close times. Skips windows already in the past. */
function buildWindows(
  weekdays: Set<number>,
  openTime: string,
  closeTime: string,
  daysAhead: number,
): Array<{ start: Date; end: Date }> {
  const [oh, om] = parseHM(openTime);
  const [ch, cm] = parseHM(closeTime);
  const now = new Date();
  const out: Array<{ start: Date; end: Date }> = [];
  for (let i = 0; i < daysAhead; i++) {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    if (!weekdays.has(day.getDay())) continue;
    const start = new Date(day);
    start.setHours(oh, om, 0, 0);
    const end = new Date(day);
    end.setHours(ch, cm, 0, 0);
    if (end <= start) continue; // same-day only; validated before we get here
    if (end <= now) continue; // window already finished today
    out.push({ start, end });
  }
  return out;
}

function fmtDay(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  });
}
function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

export function ScheduleEditor() {
  const { driver } = useDriverSession();
  const approved = React.useMemo(
    () => (driver.approvals ?? []).filter((a) => a.status === 'approved'),
    [driver.approvals],
  );
  const branchName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of approved) m.set(a.branch_id, a.branch?.name ?? 'Restaurant');
    return m;
  }, [approved]);

  const [list, setList] = React.useState<DriverScheduleRow[]>([]);
  const [loading, setLoading] = React.useState(true);

  // Form state
  const [branchId, setBranchId] = React.useState('');
  const [days, setDays] = React.useState<Set<number>>(() => new Set());
  const [openTime, setOpenTime] = React.useState('09:00');
  const [closeTime, setCloseTime] = React.useState('17:00');
  const [weeksAhead, setWeeksAhead] = React.useState(2);
  const [saving, setSaving] = React.useState(false);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [okMsg, setOkMsg] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const rows = await getDriverSchedules(supabase, driver.id);
    setList(rows);
    setLoading(false);
  }, [driver.id]);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  // Default the branch select to the first approved restaurant.
  React.useEffect(() => {
    const first = approved[0];
    if (!branchId && first) setBranchId(first.branch_id);
  }, [approved, branchId]);

  const toggleDay = (i: number) =>
    setDays((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const add = async () => {
    setError(null);
    setOkMsg(null);
    if (!branchId) return setError('Pick a restaurant.');
    if (days.size === 0) return setError('Pick at least one day of the week.');
    if (closeTime <= openTime) return setError('Close time must be after open time.');

    const windows = buildWindows(days, openTime, closeTime, weeksAhead * 7);
    if (windows.length === 0) return setError('Nothing to add — those days have already passed.');

    // Skip windows that duplicate an existing one for this branch (same start).
    const existing = new Set(
      list.filter((r) => r.branch_id === branchId).map((r) => new Date(r.start_at).getTime()),
    );
    const rows = windows
      .filter((w) => !existing.has(w.start.getTime()))
      .map((w) => ({
        driver_id: driver.id,
        branch_id: branchId,
        start_at: w.start.toISOString(),
        end_at: w.end.toISOString(),
      }));
    if (rows.length === 0) return setError('Those windows are already on your schedule.');

    setSaving(true);
    const supabase = getBrowserClient();
    const { error: insErr } = await createDriverSchedules(supabase, rows);
    setSaving(false);
    if (insErr) return setError(insErr.message);
    setOkMsg(`Added ${rows.length} window${rows.length === 1 ? '' : 's'}.`);
    setDays(new Set());
    await refresh();
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    const supabase = getBrowserClient();
    const { error: delErr } = await deleteDriverSchedule(supabase, id);
    setBusyId(null);
    if (delErr) return setError(delErr.message);
    setList((prev) => prev.filter((r) => r.id !== id));
  };

  if (approved.length === 0) {
    return (
      <EmptyState
        icon={<Store className="h-7 w-7" />}
        title="No restaurants yet"
        description="Get approved to a restaurant before setting your hours."
        action={
          <Link href="/app/apply">
            <Button variant="gradient">Apply to restaurants</Button>
          </Link>
        }
      />
    );
  }

  return (
    <>
      {/* Add-window form */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Plus className="h-5 w-5 text-primary" /> Add hours
        </h2>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium">Restaurant</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={INPUT_CLS}>
            {approved.map((a) => (
              <option key={a.branch_id} value={a.branch_id}>
                {a.branch?.name ?? 'Restaurant'}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4">
          <span className="mb-1.5 block text-sm font-medium">Days</span>
          <div className="flex gap-2">
            {WEEKDAYS.map((d) => {
              const on = days.has(d.i);
              return (
                <button
                  key={d.i}
                  type="button"
                  onClick={() => toggleDay(d.i)}
                  aria-pressed={on}
                  aria-label={d.full}
                  className={cn(
                    'h-10 flex-1 rounded-xl border text-sm font-semibold transition',
                    on
                      ? 'border-primary bg-primary text-primary-foreground'
                      : 'border-border bg-card text-muted-foreground',
                  )}
                >
                  {d.label}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3">
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Opens</span>
            <input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Closes</span>
            <input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} className={INPUT_CLS} />
          </label>
        </div>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium">Repeat for</span>
          <select
            value={weeksAhead}
            onChange={(e) => setWeeksAhead(Number(e.target.value))}
            className={INPUT_CLS}
          >
            <option value={1}>1 week</option>
            <option value={2}>2 weeks</option>
            <option value={3}>3 weeks</option>
            <option value={4}>4 weeks</option>
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Creates a window on each selected day for the coming weeks.
          </span>
        </label>

        {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
        {okMsg && <p className="mt-3 text-sm font-medium text-success">{okMsg}</p>}

        <Button onClick={add} loading={saving} fullWidth className="mt-4" leftIcon={<Plus className="h-4 w-4" />}>
          Add to schedule
        </Button>
      </Card>

      {/* Upcoming windows */}
      <h2 className="mb-3 px-1 font-display text-lg font-semibold">Upcoming</h2>
      {loading ? (
        <p className="text-center text-sm text-muted-foreground">Loading…</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck className="h-7 w-7" />}
          title="No hours set"
          description="Add the hours you want to work above and you'll go online automatically."
        />
      ) : (
        <ul className="space-y-3">
          {list.map((s) => (
            <li key={s.id}>
              <Card className="flex items-center gap-3 p-4">
                <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                  <Clock className="h-5 w-5" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{branchName.get(s.branch_id) ?? 'Restaurant'}</p>
                  <p className="text-sm text-muted-foreground">
                    {fmtDay(s.start_at)} · {fmtTime(s.start_at)}–{fmtTime(s.end_at)}
                  </p>
                </div>
                {s.status !== 'scheduled' && (
                  <Badge variant="muted" className="shrink-0">
                    {s.status}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  disabled={busyId === s.id}
                  aria-label="Remove window"
                  className="focus-ring grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition hover:bg-danger/10 hover:text-danger disabled:opacity-50"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </Card>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
