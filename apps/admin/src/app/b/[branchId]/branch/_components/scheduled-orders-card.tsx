'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { CalendarClock, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
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
// The window a diner may pick inside is NOT configured here: it is the branch's Opening
// hours, the same branch_hours rows is_branch_open() checks. One source of truth, so the
// picker and the server cannot disagree.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

const SLOT_CHOICES = [5, 10, 15, 20, 30, 60];

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
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('branches')
      .update({
        settings: {
          ...settings,
          scheduling_enabled: enabled,
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
        Pre-orders customers place for a later time. The times they can choose come from this
        branch&apos;s <strong>Opening hours</strong> above — set those, and the checkout
        picker follows automatically.
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
            Off: customers can only order for as soon as possible, and &ldquo;Schedule for
            later&rdquo; disappears from checkout.
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
