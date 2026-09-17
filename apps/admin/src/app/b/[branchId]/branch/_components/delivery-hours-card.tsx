'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Clock, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { Button, Card, RiderIcon } from '@favornoms/ui';

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

/** Raw database text never reaches the merchant: a known refusal gets its own message,
 *  anything else the generic one. */
function saveErrorKey(err: { message: string; code?: string }): string {
  if (err.code === '42501' || err.message === 'forbidden' || err.message.includes('branch_manager_required')) {
    return 'errors.noPermission';
  }
  return 'errors.generic';
}

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
  const t = useTranslations('branchOps');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const days = React.useMemo(() => weekdayNames(intlLocale), [intlLocale]);
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
      console.error('Saving delivery hours failed', rpcErr);
      setError(t(saveErrorKey(rpcErr)));
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
      console.error('Saving delivery mode failed', upErr);
      setError(t(saveErrorKey(upErr)));
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <RiderIcon className="h-5 w-5 text-primary" /> {t('deliveryHours.title')}
      </h2>

      <div className="mt-4 space-y-3">
        <p className="text-sm font-medium">{t('deliveryHours.whoDelivers')}</p>
        <div className="grid gap-2 sm:grid-cols-2">
          {(['platform', 'self'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setMode(key)}
              className={`focus-ring rounded-xl border p-3 text-left transition ${
                mode === key ? 'border-primary bg-primary/5' : 'border-border bg-card'
              }`}
            >
              <p className="text-sm font-semibold">{t(`deliveryHours.${key}.title`)}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{t(`deliveryHours.${key}.body`)}</p>
            </button>
          ))}
        </div>
        {mode === 'self' && (
          <p className="rounded-xl bg-muted/50 px-4 py-3 text-xs text-muted-foreground">
            {t('deliveryHours.selfNote')}
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
              <Clock className="h-4 w-4 text-muted-foreground" /> {t('deliveryHours.limit')}
            </span>
            <span className="block text-xs text-muted-foreground">
              {t.rich('deliveryHours.limitHint', {
                strong: (chunks) => <strong>{chunks}</strong>,
              })}
            </span>
          </span>
        </label>
      </div>

      {enabled && (
        <>
          {!loaded ? (
            <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
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
                          {t('common.copyToAll')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => addWindow(day)}
                        className="focus-ring inline-flex items-center gap-1 text-xs font-medium text-primary"
                      >
                        <Plus className="h-3.5 w-3.5" /> {t('common.addWindow')}
                      </button>
                    </div>
                  </div>
                  {(week[day]?.length ?? 0) === 0 ? (
                    <p className="mt-1 text-xs text-muted-foreground">{t('deliveryHours.noDelivery')}</p>
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
                          <span className="text-xs text-muted-foreground">{t('common.to')}</span>
                          <input
                            type="time"
                            value={win.closes_at}
                            onChange={(e) => setWindow(day, idx, { closes_at: e.target.value })}
                            className={INPUT_CLS}
                          />
                          {win.closes_at <= win.opens_at && (
                            <span className="text-xs text-muted-foreground">{t('common.overnight')}</span>
                          )}
                          <button
                            type="button"
                            onClick={() => removeWindow(day, idx)}
                            className="focus-ring ml-auto text-muted-foreground hover:text-danger"
                            aria-label={t('common.removeWindow')}
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
              {t('deliveryHours.armedButEmpty')}
            </p>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {t('deliveryHours.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
