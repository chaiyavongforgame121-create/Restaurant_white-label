'use client';

import * as React from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Clock, Globe, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';

// Weekly opening hours (branch_hours). No rows = always open (back-compat).
// A window whose close time is ≤ its open time crosses midnight (e.g. 22:00–02:00).

interface Window {
  opens_at: string; // 'HH:MM'
  closes_at: string;
}

type WeekHours = Record<number, Window[]>;

const INPUT_CLS =
  'h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-primary';

/**
 * Weekday names in the interface language, Sunday first to match day_of_week (0 = Sunday).
 * 1 January 2023 was a Sunday; UTC keeps the device's zone out of it.
 */
function weekdayNames(intlLocale: string): string[] {
  const fmt = new Intl.DateTimeFormat(intlLocale, { weekday: 'long', timeZone: 'UTC' });
  return Array.from({ length: 7 }, (_, d) => {
    const name = fmt.format(new Date(Date.UTC(2023, 0, 1 + d)));
    return name.charAt(0).toLocaleUpperCase(intlLocale) + name.slice(1);
  });
}

/**
 * Reads the wall clock at a named IANA zone. Returns null for a zone the browser cannot
 * resolve rather than throwing -- branches.timezone is free text at the database level.
 */
function clockAt(timezone: string, intlLocale: string): string | null {
  try {
    return new Date().toLocaleString(intlLocale, {
      timeZone: timezone,
      weekday: 'short',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return null;
  }
}

export function HoursEditor({ branchId, timezone }: { branchId: string; timezone: string }) {
  const t = useTranslations('branch.hours');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const days = React.useMemo(() => weekdayNames(intlLocale), [intlLocale]);
  const [week, setWeek] = React.useState<WeekHours>({});
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Null until mounted on purpose: the server renders in its own zone, so a clock printed
  // during SSR is both wrong and a hydration mismatch.
  const [branchNow, setBranchNow] = React.useState<string | null>(null);

  React.useEffect(() => {
    const tick = () => setBranchNow(clockAt(timezone, intlLocale));
    tick();
    const id = window.setInterval(tick, 30_000);
    return () => window.clearInterval(id);
  }, [timezone, intlLocale]);

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
        rpc: (
          fn: string,
          args: Record<string, unknown>,
        ) => Promise<{ error: { message: string; code?: string } | null }>;
      }
    ).rpc('set_branch_hours', { p_branch_id: branchId, p_windows: windows });
    setSaving(false);
    if (rpcErr) {
      console.error('Saving opening hours failed', rpcErr);
      setError(rpcErr.code === '42501' ? t('noPermission') : t('saveFailed'));
      return;
    }
    setSavedAt(Date.now());
  };

  const totalWindows = Object.values(week).reduce((n, wins) => n + (wins?.length ?? 0), 0);

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Clock className="h-5 w-5 text-primary" /> {t('title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('description')}</p>

      {/* is_branch_open() reads these times in the BRANCH's timezone, and the card never said
          so. A merchant setting 10:00-21:00 from a different country watched their storefront
          say "Currently closed" in the middle of their own afternoon with no way to tell why.
          The live clock is the part that makes it obvious. */}
      <p className="bg-muted/50 mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl px-3 py-2 text-sm">
        <Globe aria-hidden className="text-primary h-4 w-4 shrink-0" />
        <span>
          {t.rich('zoneNotice', {
            zone: timezone.replace(/_/g, ' '),
            strong: (chunks) => <strong>{chunks}</strong>,
          })}
        </span>
        {branchNow && (
          <span className="text-muted-foreground">{t('shopClock', { time: branchNow })}</span>
        )}
      </p>

      {!loaded ? (
        <p className="mt-4 text-sm text-muted-foreground">{t('loading')}</p>
      ) : (
        <div className="mt-4 space-y-3">
          {days.map((name, day) => (
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
                      {t('copyToAll')}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => addWindow(day)}
                    className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-primary"
                  >
                    <Plus className="h-3.5 w-3.5" /> {t('addHours')}
                  </button>
                </div>
              </div>
              {(week[day]?.length ?? 0) === 0 ? (
                <p className="mt-1 text-xs text-muted-foreground">{t('closedAllDay')}</p>
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
                      <span className="text-xs text-muted-foreground">{t('to')}</span>
                      <input
                        type="time"
                        value={win.closes_at}
                        onChange={(e) => setWindow(day, idx, { closes_at: e.target.value })}
                        className={INPUT_CLS}
                      />
                      {win.closes_at <= win.opens_at && (
                        <span className="text-xs text-muted-foreground">{t('overnight')}</span>
                      )}
                      <button
                        type="button"
                        onClick={() => removeWindow(day, idx)}
                        className="focus-ring ml-auto text-muted-foreground hover:text-danger"
                        aria-label={t('removeWindow')}
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
          {t('save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('saved')}</span>}
        {loaded && totalWindows === 0 && (
          <span className="text-xs text-muted-foreground">{t('alwaysOpen')}</span>
        )}
      </div>
    </Card>
  );
}
