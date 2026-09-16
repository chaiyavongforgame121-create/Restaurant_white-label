'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Clock, Plus, Save, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { describeRanges, effectiveBookableRanges, type WeekdayWindow } from '@favornoms/shared';
import { Button, Card } from '@favornoms/ui';

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
//   schedule_lead_time_min  did not exist. The kitchen release offset was prep_time_min,
//                           which is ALSO the number shown in customer ETAs, so tuning one
//                           silently moved the other.
//
// The window a diner may pick inside used to be unreachable too: it was the branch's
// Opening hours and nothing else, so a shop open every day that wanted pre-orders from
// 17:00 Monday to Saturday but only 10:00-14:00 on Sunday had no way to say so. That is
// what schedule_hours_enabled and the branch_schedule_hours grid below are for. They only
// ever NARROW opening hours — is_branch_open() still refuses anything outside them — so the
// picker and the server cannot disagree.
//
// Fail-CLOSED once armed, the opposite of branch_hours: switch off and opening hours alone
// decide, switch on and a day with no window is a day with no bookings.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

const TIME_INPUT_CLS =
  'h-10 rounded-lg border border-border bg-background px-2 text-sm outline-none transition-colors focus-visible:border-primary';

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
  ) => PromiseLike<{ error: { message: string } | null }>;
}

/** Mirrors storefront_status's defaults exactly. If these two drift, the picker offers
 *  times the server then refuses. */
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

export function ScheduledOrdersCard({ branchId, settings }: Props) {
  const router = useRouter();
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
  // Falls back to prep_time_min, which is what the release job used before this key
  // existed — so opening this card shows the value already in force, not a guess.
  const [kitchenLead, setKitchenLead] = React.useState(() =>
    String(intOr(settings?.schedule_lead_time_min, intOr(settings?.prep_time_min, 15))),
  );
  const [windowsEnabled, setWindowsEnabled] = React.useState(
    settings?.schedule_hours_enabled === true,
  );
  const [week, setWeek] = React.useState<WeekHours>({});
  // The branch's own opening hours, read only so the merchant can see what their booking
  // window actually resolves to. 17:00-22:00 on a day the kitchen shuts at 21:00 is an
  // honest mistake worth showing before they save it, not after a diner complains.
  const [openingHours, setOpeningHours] = React.useState<WeekdayWindow[]>([]);
  const [loaded, setLoaded] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const db = getBrowserClient() as unknown as UntypedClient;
      const [scheduleRows, openingRows] = await Promise.all([
        db.from('branch_schedule_hours').select('day_of_week, opens_at, closes_at').eq('branch_id', branchId),
        db.from('branch_hours').select('day_of_week, opens_at, closes_at').eq('branch_id', branchId),
      ]);
      if (cancelled) return;
      setWeek(toWeek(scheduleRows.data));
      setOpeningHours(flatten(toWeek(openingRows.data)));
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
  // copy the opening hours in, then trim the one day that differs.
  const sameAsOpeningHours = () => {
    const w: WeekHours = {};
    for (const h of openingHours) {
      (w[h.day_of_week] ??= []).push({ opens_at: h.opens_at, closes_at: h.closes_at });
    }
    setWeek(w);
  };

  const draftWindows = flatten(week);
  const armedButEmpty = windowsEnabled && loaded && draftWindows.length === 0;

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
        setError(rpcErr.message);
        return;
      }
    }

    const { error: updateError } = await supabase
      .from('branches')
      .update({
        settings: {
          ...settings,
          scheduling_enabled: enabled,
          schedule_hours_enabled: windowsEnabled,
          schedule_min_lead_min: Math.max(0, Math.min(24 * 60, intOr(minLead, DEFAULTS.schedule_min_lead_min))),
          schedule_max_days: Math.max(0, Math.min(365, intOr(maxDays, DEFAULTS.schedule_max_days))),
          schedule_slot_minutes: Math.max(5, Math.min(60, intOr(slot, DEFAULTS.schedule_slot_minutes))),
          schedule_lead_time_min: Math.max(0, Math.min(7 * 24 * 60, intOr(kitchenLead, 15))),
        },
      })
      .eq('id', branchId);
    setSaving(false);
    if (updateError) {
      setError(updateError.message);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <CalendarClock className="h-5 w-5 text-primary" /> Scheduled orders
      </h2>
      <p className="text-sm text-muted-foreground">
        How customers book deliveries: on your storefront every delivery is booked for a day
        and time, and pickup is always ordered for now. Bookable times start from this
        branch&apos;s <strong>Opening hours</strong> above, narrowed by the booking windows below
        when you switch those on, and by <strong>Delivery hours</strong> when those are limited.
        A branch that does not sell delivery takes no bookings from customers.
      </p>

      <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-1 h-4 w-4"
        />
        <span>
          <span className="block text-sm font-semibold">Accept scheduled orders</span>
          <span className="block text-xs text-muted-foreground">
            Customers book every delivery for a day and time. Off: &ldquo;Schedule
            Delivery&rdquo; disappears from your storefront and customers can only order Pickup.
          </span>
        </span>
      </label>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Earliest booking (minutes ahead)</span>
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
          <span className="mt-1 block text-xs text-muted-foreground">
            How far in advance a customer must book. Slots sooner than this are not offered.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Furthest booking (days ahead)</span>
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
          <span className="mt-1 block text-xs text-muted-foreground">
            0 turns scheduling into same-day only.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Time slot size</span>
          <select
            value={slot}
            onChange={(e) => setSlot(e.target.value)}
            className={INPUT_CLS}
          >
            {SLOT_CHOICES.map((m) => (
              <option key={m} value={m}>
                Every {m} minutes
              </option>
            ))}
          </select>
          <span className="mt-1 block text-xs text-muted-foreground">
            Rounds the offered times. Bigger slots mean fewer, tidier choices.
          </span>
        </label>

        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Send to kitchen (minutes before)</span>
          <input
            type="number"
            min={0}
            max={7 * 24 * 60}
            step="5"
            inputMode="numeric"
            value={kitchenLead}
            onChange={(e) => setKitchenLead(e.target.value)}
            className={INPUT_CLS}
          />
          {/* The distinction this field exists to make. Before it, both numbers were
              prep_time_min, so a caterer who needed a day of lead time had to quote a
              one-day ETA to every walk-up customer to get it. */}
          <span className="mt-1 block text-xs text-muted-foreground">
            A booking stays out of the kitchen display until this long before its time. This
            is <strong>not</strong> the prep time shown in customer ETAs — that stays on the
            Delivery card.
          </span>
        </label>
      </div>

      {/* The two lead times are separate keys and nothing links them, so a merchant can ask
          for a day's notice in the kitchen and still let a diner book fifteen minutes out.
          Nothing breaks — the booking simply is not held — but it is never what they meant,
          and there was no way to notice it before placing the order. */}
      {enabled && intOr(kitchenLead, 15) > intOr(minLead, DEFAULTS.schedule_min_lead_min) && (
        <p role="status" className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
          Customers can book {intOr(minLead, DEFAULTS.schedule_min_lead_min)} minutes ahead,
          but you asked for {intOr(kitchenLead, 15)} minutes of kitchen notice. Anything
          booked inside that gap reaches the kitchen straight away, with less notice than
          you wanted. Raise <strong>Earliest booking</strong> to match if that matters.
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
                  <Clock className="h-4 w-4 text-muted-foreground" /> Limit the times
                  customers can book
                </span>
                <span className="block text-xs text-muted-foreground">
                  Off: customers can book any time the branch is open. On: only inside the
                  windows below — set a different one per day, so you can take bookings from
                  5pm all week and only 10am–2pm on Sunday.
                </span>
              </span>
            </label>
          </div>

          {windowsEnabled && (
            <>
              {!loaded ? (
                <p className="mt-4 text-sm text-muted-foreground">Loading…</p>
              ) : (
                <div className="mt-4 space-y-3">
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={sameAsOpeningHours}
                      className="focus-ring text-xs font-medium text-primary underline"
                    >
                      Same as opening hours
                    </button>
                  </div>
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
                        <p className="mt-1 text-xs text-muted-foreground">
                          No advance orders this day
                        </p>
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
                              <span className="text-xs text-muted-foreground">to</span>
                              <input
                                type="time"
                                value={win.closes_at}
                                onChange={(e) => setWindow(day, idx, { closes_at: e.target.value })}
                                className={TIME_INPUT_CLS}
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
                          {/* The answer to "why can nobody book at 10pm?": the branch is
                              shut then, and a booking window cannot open a closed kitchen. */}
                          <p className="text-xs text-muted-foreground">
                            Customers will see:{' '}
                            {describeRanges(
                              effectiveBookableRanges(openingHours, draftWindows, day),
                              'nothing — the branch is closed during these hours',
                            )}
                          </p>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {armedButEmpty && (
                <p className="mt-3 rounded-xl bg-warning/10 px-4 py-3 text-sm">
                  Booking windows are switched on but none are set — customers cannot
                  schedule an order at all. Add a window, or switch this off.
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
          Save scheduling
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
    </Card>
  );
}
