'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarClock, Clock, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  asapDeliveryEnabled,
  DEFAULT_UI_LOCALE,
  describeRanges,
  intlLocaleFor,
  isUiLocale,
  kitchenLeadMin,
  type MinuteRange,
  type UiLocale,
  type WeekdayWindow,
} from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';
import { bookingPreview, type BookingPreview } from './delivery-hours-model';
import { useSettingsPatch } from './patch-settings';

// Scheduling policy for this branch. Merges its own keys into branches.settings and never
// clobbers the rest, matching ServiceFeeCard.
//
// Every value here used to be a constant somewhere the merchant could not reach:
//
//   scheduling_enabled      there was no off switch — "Schedule for later" was always on.
//   schedule_min_lead_min   hardcoded twice, and differently: the checkout input said
//                           now+15m, place-order rejected under now+10m. A diner picking a
//                           12-minute-out slot passed the picker and failed the submit.
//   schedule_max_days       hardcoded 14 in both places.
//
// When a booking reaches the kitchen is NOT set here. It had its own key for a while
// (schedule_lead_time_min, "Send to kitchen (minutes before)"), until the owner decided on
// 2026-11-16 that the prep time is that moment too: one number the kitchen actually needs, so
// updating it moves customer ETAs and the kitchen's notice together. The lead is the Delivery
// card's prep time plus the kitchen's Busy extra (kitchenLeadMin); this card only shows it. The
// old key stays in older rows and nothing reads it.
//
// The window a diner may pick inside used to be unreachable too: it was the branch's
// Opening hours and nothing else, so a shop open every day that wanted pre-orders from
// 17:00 Monday to Saturday but only 10:00-14:00 on Sunday had no way to say so. That is
// what schedule_hours_enabled and the branch_schedule_hours grid below are for. They only
// ever NARROW the branch's delivery hours — is_branch_open_for(branch, 'delivery', at) still
// refuses anything outside them — so the picker and the server cannot disagree. Those delivery
// hours are the opening hours, or, with the Delivery card's "Limit delivery to set hours" on,
// that card's windows on their own, which may lie before opening or after closing (owner
// report 2026-11-16: a shop open 09:00-17:30 delivering 08:00-09:00 and 18:00-19:00).
//
// Fail-CLOSED once armed, the opposite of branch_hours: switch off and the delivery hours alone
// decide, switch on and a day with no window is a day with no bookings.
//
// The card also owns asap_delivery_enabled ("Accept ASAP delivery orders", owner request
// 2026-10-26): together with scheduling_enabled it decides the storefront's "When" block for a
// delivery — the "As soon as possible" box, the day and time pickers, or both. Off unless it is
// exactly true (asapDeliveryEnabled), so a branch that never saved it shows unticked, as the
// storefront and place-order read it.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
  /** The Delivery card's SAVED windows (branch_delivery_hours), null when they could not be read.
   *  Its saved switch is settings.delivery_hours_enabled. */
  deliveryWindows: WeekdayWindow[] | null;
  /** Opening hours as saved (branch_hours; empty is always open), null when they could not be
   *  read. Read by the page, so the Opening hours card's save (router.refresh) reaches the
   *  preview here; this card used to read them once on mount and kept the old hours. */
  openingHours: WeekdayWindow[] | null;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

const TIME_INPUT_CLS =
  'h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-primary';

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

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
  opens_at: string; // 'HH:MM'
  closes_at: string;
}
type WeekHours = Record<number, Window[]>;

/** packages/database/src/types.ts is regenerated centrally and predates
 *  branch_schedule_hours and set_branch_schedule_hours, so both go through an untyped view
 *  of the client — the same escape hatch hours-editor.tsx uses for set_branch_hours. Drop
 *  the cast when types.ts next lands. */
interface UntypedClient {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => PromiseLike<{ data: unknown }>;
    };
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>,
  ) => PromiseLike<{ error: { message: string; code?: string } | null }>;
}

/** Mirrors storefront_status's defaults exactly. If these two drift, the picker offers
 *  times the server then refuses. asap_delivery_enabled is not here: storefront_status does not
 *  carry it, and a missing key is off (ASAP_DELIVERY_DEFAULT, read through asapDeliveryEnabled). */
const DEFAULTS = {
  scheduling_enabled: true,
  schedule_min_lead_min: 15,
  schedule_max_days: 14,
  schedule_slot_minutes: 15,
};

function intOr(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Postgres `time` arrives as 'HH:MM:SS'; the <input type="time"> wants 'HH:MM'. */
function toWeek(rows: unknown): WeekHours {
  const week: WeekHours = {};
  for (const row of Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : []) {
    const day = Number(row.day_of_week);
    if (!Number.isInteger(day) || day < 0 || day > 6) continue;
    (week[day] ??= []).push({
      opens_at: String(row.opens_at).slice(0, 5),
      closes_at: String(row.closes_at).slice(0, 5),
    });
  }
  for (const day of Object.keys(week)) {
    week[Number(day)]?.sort((a, b) => a.opens_at.localeCompare(b.opens_at));
  }
  return week;
}

function flatten(week: WeekHours): WeekdayWindow[] {
  return Object.entries(week).flatMap(([day, wins]) =>
    (wins ?? [])
      .filter((w) => w.opens_at && w.closes_at)
      .map((w) => ({ day_of_week: Number(day), opens_at: w.opens_at, closes_at: w.closes_at })),
  );
}

export function ScheduledOrdersCard({ branchId, settings, deliveryWindows, openingHours }: Props) {
  const t = useTranslations('branchOps');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const days = React.useMemo(() => weekdayNames(intlLocaleFor(locale)), [locale]);
  const router = useRouter();
  // Sends only what changed since this card was rendered or last saved.
  const savePatch = useSettingsPatch(branchId, settings);
  // "Accept ASAP delivery orders": unticked unless the branch saved exactly true.
  const [asap, setAsap] = React.useState(() => asapDeliveryEnabled(settings));
  const [enabled, setEnabled] = React.useState<boolean>(
    settings?.scheduling_enabled === undefined
      ? DEFAULTS.scheduling_enabled
      : settings.scheduling_enabled === true,
  );
  const [minLead, setMinLead] = React.useState(() =>
    String(intOr(settings?.schedule_min_lead_min, DEFAULTS.schedule_min_lead_min)),
  );
  const [maxDays, setMaxDays] = React.useState(() =>
    String(intOr(settings?.schedule_max_days, DEFAULTS.schedule_max_days)),
  );
  const [slot, setSlot] = React.useState(() =>
    String(intOr(settings?.schedule_slot_minutes, DEFAULTS.schedule_slot_minutes)),
  );
  const [windowsEnabled, setWindowsEnabled] = React.useState(
    settings?.schedule_hours_enabled === true,
  );
  const [week, setWeek] = React.useState<WeekHours>({});
  // The branch's own opening hours (openingHours, a prop) are read only so the merchant can see
  // what their booking window actually resolves to. 17:00-22:00 on a day the kitchen shuts at
  // 21:00 is an honest mistake worth showing before they save it, not after a diner complains.
  // Read from the props on every render, not copied into state: the Delivery and Opening hours
  // cards' saves refresh the page, and the preview must follow the switch, windows and opening
  // hours the server reads.
  const deliveryHoursOn = settings?.delivery_hours_enabled === true;
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = getBrowserClient() as unknown as UntypedClient;
      const scheduleRows = await db
        .from('branch_schedule_hours')
        .select('day_of_week, opens_at, closes_at')
        .eq('branch_id', branchId);
      if (cancelled) return;
      setWeek(toWeek(scheduleRows.data));
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);

  const setWindow = (day: number, idx: number, patch: Partial<Window>) =>
    setWeek((w) => ({
      ...w,
      [day]: (w[day] ?? []).map((win, i) => (i === idx ? { ...win, ...patch } : win)),
    }));
  const addWindow = (day: number) =>
    setWeek((w) => ({
      ...w,
      [day]: [...(w[day] ?? []), { opens_at: '17:00', closes_at: '22:00' }],
    }));
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
  // One click to a sane starting point, and the shortest route to the common layout:
  // copy the delivery hours in, then trim the one day that differs. Those are the opening
  // hours, or the Delivery card's windows while delivery is limited to them: copying opening
  // hours then would book 09:00-17:30 against 08:00-09:00 deliveries and offer nothing.
  const copyFromDelivery = deliveryHoursOn && deliveryWindows !== null;
  // Nothing to copy when the hours it would copy could not be read: copying "nothing" would
  // clear the grid.
  const copySource = copyFromDelivery ? deliveryWindows : openingHours;
  const sameAsDeliveryHours = () => {
    if (!copySource) return;
    const w: WeekHours = {};
    for (const h of copySource) {
      (w[h.day_of_week] ??= []).push({ opens_at: h.opens_at, closes_at: h.closes_at });
    }
    for (const day of Object.keys(w)) {
      w[Number(day)]?.sort((a, b) => a.opens_at.localeCompare(b.opens_at));
    }
    setWeek(w);
  };

  const draftWindows = flatten(week);
  const armedButEmpty = windowsEnabled && loaded && draftWindows.length === 0;
  // When a booking reaches the kitchen, from the saved settings (the Delivery card's save
  // refreshes them) by the one rule the release job, place-order and the kitchen board all read
  // (kitchenLeadMin), so this says what the server does. The prep part alone is the same rule
  // with no Busy extra; the rest is the Busy extra in force now.
  const leadMinutes = kitchenLeadMin(settings);
  const busyMinutes = leadMinutes - kitchenLeadMin({ prep_time_min: settings?.prep_time_min });
  const minLeadMinutes = intOr(minLead, DEFAULTS.schedule_min_lead_min);

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();

    // Only once the grid has actually loaded. Saving the four scalars before the read
    // returned would send an empty window list to an atomic replace and wipe the week the
    // merchant never saw.
    if (loaded) {
      // Windows first: if the settings write lands and this one fails, the branch is armed
      // with no windows, which is "no bookings at all".
      const { error: rpcErr } = await (supabase as unknown as UntypedClient).rpc(
        'set_branch_schedule_hours',
        { p_branch_id: branchId, p_windows: draftWindows },
      );
      if (rpcErr) {
        setSaving(false);
        console.error('Saving booking windows failed', rpcErr);
        setError(t(saveErrorKey(rpcErr)));
        return;
      }
    }

    // Only the keys that changed, merged on the server into the row as it is now.
    const { error: updateError } = await savePatch({
      asap_delivery_enabled: asap,
      scheduling_enabled: enabled,
      schedule_hours_enabled: windowsEnabled,
      schedule_min_lead_min: Math.max(0, Math.min(24 * 60, intOr(minLead, DEFAULTS.schedule_min_lead_min))),
      schedule_max_days: Math.max(0, Math.min(365, intOr(maxDays, DEFAULTS.schedule_max_days))),
      schedule_slot_minutes: Math.max(5, Math.min(60, intOr(slot, DEFAULTS.schedule_slot_minutes))),
    });
    setSaving(false);
    if (updateError) {
      console.error('Saving scheduling settings failed', updateError);
      setError(t(saveErrorKey(updateError)));
      // The booking windows may have been saved above; the Delivery card warns from them.
      if (loaded) router.refresh();
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const strong = (chunks: React.ReactNode) => <strong>{chunks}</strong>;

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <CalendarClock className="h-5 w-5 text-primary" /> {t('scheduling.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t.rich('scheduling.description', { strong })}</p>

      {/* ASAP first, then bookings: the order the storefront shows them in. */}
      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
        <input
          type="checkbox"
          checked={asap}
          onChange={(e) => setAsap(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-semibold">{t('scheduling.asap')}</span>
          <span className="block text-xs text-muted-foreground">{t('scheduling.asapHint')}</span>
        </span>
      </label>

      <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-semibold">{t('scheduling.accept')}</span>
          <span className="block text-xs text-muted-foreground">{t('scheduling.acceptHint')}</span>
        </span>
      </label>

      {/* Both off is allowed — a branch may stop taking deliveries online — but it is never a
          surprise: delivery leaves the storefront entirely, so say it before it is saved. */}
      {!asap && !enabled && (
        <p role="status" className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
          {t('scheduling.noDelivery')}
        </p>
      )}

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('scheduling.minLead')}</span>
          <input
            type="number"
            min={0}
            max={24 * 60}
            step="5"
            inputMode="numeric"
            value={minLead}
            onChange={(e) => setMinLead(e.target.value)}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('scheduling.minLeadHint')}</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('scheduling.maxDays')}</span>
          <input
            type="number"
            min={0}
            max={365}
            step="1"
            inputMode="numeric"
            value={maxDays}
            onChange={(e) => setMaxDays(e.target.value)}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-xs text-muted-foreground">{t('scheduling.maxDaysHint')}</span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">{t('scheduling.slot')}</span>
          <select
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            className={INPUT_CLS}
          >
            {SLOT_CHOICES.map((m) => (
              <option key={m} value={m}>
                {t('scheduling.slotOption', { minutes: m })}
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">{t('scheduling.slotHint')}</span>
        </label>
      </div>

      {/* Read-only: the lead is the Delivery card's prep time (plus Busy), so it is changed
          there. Shown here because this is where a merchant looks for when bookings reach the
          kitchen. */}
      <p className="mt-4 rounded-xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
        {busyMinutes > 0
          ? t.rich('scheduling.kitchenReachBusy', { minutes: leadMinutes, busyMinutes, strong })
          : t.rich('scheduling.kitchenReach', { minutes: leadMinutes, strong })}
      </p>

      {/* Earliest booking and the kitchen lead are separate settings and nothing links them, so
          a diner can book closer than the kitchen needs. Nothing breaks — the booking simply is
          not held — but it is never what the merchant meant, and there was no way to notice it
          before placing the order. */}
      {enabled && leadMinutes > minLeadMinutes && (
        <p role="status" className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
          {t.rich('scheduling.leadGap', {
            bookMinutes: minLeadMinutes,
            kitchenMinutes: leadMinutes,
            strong,
          })}
        </p>
      )}

      {/* Hidden entirely when scheduling is off: booking windows for a feature the merchant
          just switched off are a question with no meaning. */}
      {enabled && (
        <>
          <div className="mt-6 border-t border-border pt-4">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={windowsEnabled}
                onChange={(e) => setWindowsEnabled(e.target.checked)}
                className="mt-1 h-5 w-5 accent-primary"
              />
              <span>
                <span className="flex items-center gap-1.5 text-sm font-medium">
                  <Clock className="h-4 w-4 text-muted-foreground" /> {t('scheduling.limit')}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t('scheduling.limitHint')}
                </span>
              </span>
            </label>
          </div>

          {windowsEnabled && (
            <>
              {!loaded ? (
                <p className="mt-4 text-sm text-muted-foreground">{t('common.loading')}</p>
              ) : (
                <div className="mt-4 space-y-3">
                  {copySource && (
                    <div className="flex justify-end">
                      <button
                        type="button"
                        onClick={sameAsDeliveryHours}
                        className="focus-ring text-xs font-medium text-primary underline"
                      >
                        {t(copyFromDelivery ? 'scheduling.sameAsDelivery' : 'scheduling.sameAsOpening')}
                      </button>
                    </div>
                  )}
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
                        <>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {t('scheduling.noBookings')}
                          </p>
                          {/* The Delivery card warns about this day too; say it here as well. */}
                          <NotBookableLine
                            ranges={
                              bookingPreview(openingHours, draftWindows, day, deliveryHoursOn, deliveryWindows)
                                ?.notBookable ?? []
                            }
                            locale={locale}
                          />
                        </>
                      ) : (
                        <div className="mt-2 space-y-2">
                          {(week[day] ?? []).map((win, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <input
                                type="time"
                                value={win.opens_at}
                                onChange={(e) => setWindow(day, idx, { opens_at: e.target.value })}
                                className={TIME_INPUT_CLS}
                              />
                              <span className="text-xs text-muted-foreground">{t('common.to')}</span>
                              <input
                                type="time"
                                value={win.closes_at}
                                onChange={(e) => setWindow(day, idx, { closes_at: e.target.value })}
                                className={TIME_INPUT_CLS}
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
                          {/* The answer to "why can nobody book at 10pm?": the branch does
                              not deliver then, and a booking window cannot open delivery hours
                              that are closed. Left out when the hours that decide (the Delivery
                              card's windows, or opening hours) could not be read, rather than
                              guessed. */}
                          <CustomersSee
                            preview={bookingPreview(
                              openingHours,
                              draftWindows,
                              day,
                              deliveryHoursOn,
                              deliveryWindows,
                            )}
                            locale={locale}
                          />
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {armedButEmpty && (
                <p className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
                  {t('scheduling.armedButEmpty')}
                </p>
              )}
            </>
          )}
        </>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {t('scheduling.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}

/** One day's "Customers will see" line, and the way out when it says nothing. */
function CustomersSee({ preview, locale }: { preview: BookingPreview | null; locale: UiLocale }) {
  const t = useTranslations('branchOps');
  if (!preview) return null;
  const emptyLabel =
    preview.empty === 'outsideDelivery'
      ? t('scheduling.noDeliveryDuringWindows')
      : preview.empty === 'noWindows'
        ? t('scheduling.noBookings')
        : t('scheduling.closedDuringWindows');
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {t('scheduling.customersSee', { ranges: describeRanges(preview.ranges, emptyLabel, locale) })}
      </p>
      {/* The owner's report of 2026-11-16: windows outside opening hours were saved here and
          nothing could be ordered. Delivery can run outside opening hours, but only through the
          Delivery card's own windows, so say where. */}
      {preview.empty === 'outsideOpening' && (
        <p role="status" className="rounded-xl bg-primary/5 px-3 py-2 text-xs">
          {t.rich('scheduling.outsideOpeningFix', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      )}
      <NotBookableLine ranges={preview.notBookable} locale={locale} />
    </>
  );
}

/** Delivery hours these booking windows leave out (the owner's report of 2026-11-16: delivery
 *  moved to 07:00-08:00 while the day still booked from 08:00, and only the evening was offered). */
function NotBookableLine({ ranges, locale }: { ranges: MinuteRange[]; locale: UiLocale }) {
  const t = useTranslations('branchOps');
  if (ranges.length === 0) return null;
  return (
    <p role="status" className="mt-2 rounded-xl bg-warning/10 px-3 py-2 text-xs">
      {t.rich('scheduling.deliveryNotBookable', {
        ranges: describeRanges(ranges, undefined, locale),
        strong: (chunks) => <strong>{chunks}</strong>,
      })}
    </p>
  );
}
