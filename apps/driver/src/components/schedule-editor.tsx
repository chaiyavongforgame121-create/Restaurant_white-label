'use client';

import * as React from 'react';
import Link from 'next/link';
import { CalendarCheck, Clock, Plus, Store, Trash2 } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
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

/** JS weekday numbers (Date#getDay), Sunday first — the values buildWindows matches on. */
const WEEKDAY_INDEXES = [0, 1, 2, 3, 4, 5, 6] as const;
// 2024-01-07 was a Sunday. Noon UTC, formatted in UTC, is that weekday on every device.
const A_SUNDAY_UTC_MS = Date.UTC(2024, 0, 7, 12);
const DAY_MS = 86_400_000;

/** Window statuses with a translated badge; anything else is shown as stored. */
const LABELLED_STATUSES = new Set(['active', 'completed', 'cancelled']);

/** Exclusion-constraint violation: the new window overlaps one already on the schedule. */
const PG_EXCLUSION_VIOLATION = '23P01';

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

export function ScheduleEditor() {
  const t = useTranslations('home');
  const localeValue = useLocale();
  const locale = isUiLocale(localeValue) ? localeValue : DEFAULT_UI_LOCALE;
  const { driver } = useDriverSession();
  const restaurantFallback = t('restaurant');
  const approved = React.useMemo(
    () => (driver.approvals ?? []).filter((a) => a.status === 'approved'),
    [driver.approvals],
  );
  const branchName = React.useMemo(() => {
    const m = new Map<string, string>();
    for (const a of approved) m.set(a.branch_id, a.branch?.name ?? restaurantFallback);
    return m;
  }, [approved, restaurantFallback]);

  // Day buttons and window times in the interface language. Windows are built and shown in
  // the device's own time zone (no timeZone option), exactly as the rider entered them.
  const { weekdays, fmtDay, fmtTime } = React.useMemo(() => {
    const tag = intlLocaleFor(locale);
    const narrow = new Intl.DateTimeFormat(tag, { weekday: 'narrow', timeZone: 'UTC' });
    const long = new Intl.DateTimeFormat(tag, { weekday: 'long', timeZone: 'UTC' });
    const day = new Intl.DateTimeFormat(tag, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = new Intl.DateTimeFormat(tag, { hour: 'numeric', minute: '2-digit' });
    return {
      weekdays: WEEKDAY_INDEXES.map((i) => {
        const d = new Date(A_SUNDAY_UTC_MS + i * DAY_MS);
        return { i, label: narrow.format(d), full: long.format(d) };
      }),
      fmtDay: (iso: string) => day.format(new Date(iso)),
      fmtTime: (iso: string) => time.format(new Date(iso)),
    };
  }, [locale]);

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
    if (!branchId) return setError(t('schedule.errors.pickRestaurant'));
    if (days.size === 0) return setError(t('schedule.errors.pickDay'));
    if (closeTime <= openTime) return setError(t('schedule.errors.closeAfterOpen'));

    const windows = buildWindows(days, openTime, closeTime, weeksAhead * 7);
    if (windows.length === 0) return setError(t('schedule.errors.nothingToAdd'));

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
    if (rows.length === 0) return setError(t('schedule.errors.duplicate'));

    setSaving(true);
    const supabase = getBrowserClient();
    const { error: insErr } = await createDriverSchedules(supabase, rows);
    setSaving(false);
    if (insErr) {
      // The database's wording is for logs; the rider gets a sentence in their language.
      console.error('[schedule] add failed:', insErr.message);
      return setError(
        t(insErr.code === PG_EXCLUSION_VIOLATION ? 'schedule.errors.overlap' : 'schedule.errors.saveFailed'),
      );
    }
    setOkMsg(t('schedule.added', { count: rows.length }));
    setDays(new Set());
    await refresh();
  };

  const remove = async (id: string) => {
    setBusyId(id);
    setError(null);
    const supabase = getBrowserClient();
    const { error: delErr } = await deleteDriverSchedule(supabase, id);
    setBusyId(null);
    if (delErr) {
      console.error('[schedule] remove failed:', delErr.message);
      return setError(t('schedule.errors.removeFailed'));
    }
    setList((prev) => prev.filter((r) => r.id !== id));
  };

  if (approved.length === 0) {
    return (
      <EmptyState
        icon={<Store className="h-7 w-7" />}
        title={t('schedule.noRestaurants')}
        description={t('schedule.noRestaurantsHint')}
        action={
          <Link href="/app/apply">
            <Button variant="gradient">{t('apply.title')}</Button>
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
          <Plus className="h-5 w-5 text-primary" /> {t('schedule.addHours')}
        </h2>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium">{t('restaurant')}</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={INPUT_CLS}>
            {approved.map((a) => (
              <option key={a.branch_id} value={a.branch_id}>
                {a.branch?.name ?? restaurantFallback}
              </option>
            ))}
          </select>
        </label>

        <div className="mt-4">
          <span className="mb-1.5 block text-sm font-medium">{t('schedule.days')}</span>
          <div className="flex gap-2">
            {weekdays.map((d) => {
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
            <span className="mb-1.5 block text-sm font-medium">{t('schedule.opens')}</span>
            <input type="time" value={openTime} onChange={(e) => setOpenTime(e.target.value)} className={INPUT_CLS} />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">{t('schedule.closes')}</span>
            <input type="time" value={closeTime} onChange={(e) => setCloseTime(e.target.value)} className={INPUT_CLS} />
          </label>
        </div>

        <label className="mt-4 block">
          <span className="mb-1.5 block text-sm font-medium">{t('schedule.repeatFor')}</span>
          <select
            value={weeksAhead}
            onChange={(e) => setWeeksAhead(Number(e.target.value))}
            className={INPUT_CLS}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {t('schedule.weeks', { count: n })}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">{t('schedule.repeatHint')}</span>
        </label>

        {error && <p className="mt-3 text-sm font-medium text-danger">{error}</p>}
        {okMsg && <p className="mt-3 text-sm font-medium text-success">{okMsg}</p>}

        <Button onClick={add} loading={saving} fullWidth className="mt-4" leftIcon={<Plus className="h-4 w-4" />}>
          {t('schedule.addToSchedule')}
        </Button>
      </Card>

      {/* Upcoming windows */}
      <h2 className="mb-3 px-1 font-display text-lg font-semibold">{t('schedule.upcoming')}</h2>
      {loading ? (
        <p className="text-center text-sm text-muted-foreground">{t('schedule.loading')}</p>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<CalendarCheck className="h-7 w-7" />}
          title={t('schedule.empty')}
          description={t('schedule.emptyHint')}
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
                  <p className="truncate font-semibold">{branchName.get(s.branch_id) ?? restaurantFallback}</p>
                  <p className="text-sm text-muted-foreground">
                    {fmtDay(s.start_at)} · {fmtTime(s.start_at)}–{fmtTime(s.end_at)}
                  </p>
                </div>
                {s.status !== 'scheduled' && (
                  <Badge variant="muted" className="shrink-0">
                    {LABELLED_STATUSES.has(s.status) ? t(`schedule.status.${s.status}`) : s.status}
                  </Badge>
                )}
                <button
                  type="button"
                  onClick={() => void remove(s.id)}
                  disabled={busyId === s.id}
                  aria-label={t('schedule.remove')}
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
