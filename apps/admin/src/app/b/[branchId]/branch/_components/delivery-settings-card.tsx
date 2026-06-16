'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Bike, Save } from 'lucide-react';
import {
  DELIVERY_SETTING_DEFAULTS,
  computeDeliveryFee,
  heuristicEtaMin,
  parseDeliverySettings,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Structured editor for the delivery keys inside branches.settings (jsonb).
// Saves independently from the main BranchSettings form — merges keys, never
// clobbers unrelated settings.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

type NumericKey =
  | 'delivery_base_fee'
  | 'delivery_per_km_fee'
  | 'delivery_min_fee'
  | 'delivery_max_fee'
  | 'delivery_radius_km'
  | 'prep_time_min'
  | 'driver_search_radius_km'
  | 'driver_max_attempts'
  | 'offer_ttl_seconds'
  | 'driver_base_pay'
  | 'driver_per_km_pay';

const FIELDS: Array<{
  key: NumericKey;
  label: string;
  hint?: string;
  step?: string;
  group: 'fees' | 'timing' | 'dispatch' | 'pay';
  fallback: number;
}> = [
  { key: 'delivery_base_fee', label: 'Base fee ($)', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryBaseFee },
  { key: 'delivery_per_km_fee', label: 'Per km ($)', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryPerKmFee },
  { key: 'delivery_min_fee', label: 'Minimum fee ($)', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryMinFee },
  { key: 'delivery_max_fee', label: 'Maximum fee ($)', group: 'fees', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.deliveryMaxFee },
  { key: 'delivery_radius_km', label: 'Delivery radius (km)', hint: 'Orders beyond this distance are rejected at checkout', group: 'timing', step: '0.5', fallback: DELIVERY_SETTING_DEFAULTS.deliveryRadiusKm },
  { key: 'prep_time_min', label: 'Prep time (min)', hint: 'Baseline kitchen time used in customer ETAs', group: 'timing', step: '1', fallback: DELIVERY_SETTING_DEFAULTS.prepTimeMin },
  { key: 'driver_search_radius_km', label: 'Driver search radius (km)', hint: 'How far from the branch to look for drivers', group: 'dispatch', step: '0.5', fallback: 3 },
  { key: 'driver_max_attempts', label: 'Max dispatch attempts', hint: 'Staff get alerted after this many failed rounds', group: 'dispatch', step: '1', fallback: 3 },
  { key: 'offer_ttl_seconds', label: 'Offer timeout (sec)', hint: 'How long a driver has to accept an offer', group: 'dispatch', step: '5', fallback: DELIVERY_SETTING_DEFAULTS.offerTtlSeconds },
  { key: 'driver_base_pay', label: 'Driver base pay ($)', group: 'pay', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.driverBasePay },
  { key: 'driver_per_km_pay', label: 'Driver per km ($)', group: 'pay', step: '0.01', fallback: DELIVERY_SETTING_DEFAULTS.driverPerKmPay },
];

const GROUP_TITLES: Record<string, string> = {
  fees: 'Customer delivery fee',
  timing: 'Radius & timing',
  dispatch: 'Dispatch',
  pay: 'Driver pay',
};

export function DeliverySettingsCard({ branchId, settings }: Props) {
  const router = useRouter();
  const [values, setValues] = React.useState<Record<NumericKey, string>>(() => {
    const out = {} as Record<NumericKey, string>;
    for (const f of FIELDS) {
      const raw = settings?.[f.key];
      const n = typeof raw === 'string' ? Number(raw) : (raw as number | undefined);
      out[f.key] = typeof n === 'number' && Number.isFinite(n) ? String(n) : String(f.fallback);
    }
    return out;
  });
  const [paused, setPaused] = React.useState<boolean>(Boolean(settings?.orders_paused));
  const [busyExtra, setBusyExtra] = React.useState<string>(() => {
    const n = Number(settings?.busy_extra_prep_min);
    return Number.isFinite(n) && n > 0 ? String(n) : '0';
  });
  const [surge, setSurge] = React.useState<number>(() => {
    const n = Number(settings?.delivery_surge_multiplier);
    return Number.isFinite(n) && n >= 1 ? Math.min(2, n) : 1;
  });
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Live preview using the exact formula place-order/quote_delivery applies.
  const preview = React.useMemo(() => {
    const numeric: Record<string, number> = {};
    for (const f of FIELDS) numeric[f.key] = Number(values[f.key]) || f.fallback;
    numeric.delivery_surge_multiplier = surge;
    numeric.busy_extra_prep_min = Number(busyExtra) || 0;
    const parsed = parseDeliverySettings(numeric);
    return [1, 3, 5].map((km) => ({
      km,
      fee: computeDeliveryFee(parsed, km),
      eta: heuristicEtaMin(parsed, km),
      inRange: km <= parsed.deliveryRadiusKm,
    }));
  }, [values, surge, busyExtra]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const patch: Record<string, number | boolean> = {};
    for (const f of FIELDS) {
      const n = Number(values[f.key]);
      patch[f.key] = Number.isFinite(n) && n >= 0 ? n : f.fallback;
    }
    patch.orders_paused = paused;
    patch.busy_extra_prep_min = Math.max(0, Number(busyExtra) || 0);
    patch.delivery_surge_multiplier = Math.min(2, Math.max(1, surge));
    // Merge into the existing jsonb — other settings keys stay untouched.
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, ...patch } })
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
        <Bike className="h-5 w-5 text-primary" /> Delivery
      </h2>
      <p className="text-sm text-muted-foreground">
        Distance-based pricing, delivery radius, and dispatch behavior for this branch.
      </p>

      {(['fees', 'timing', 'dispatch', 'pay'] as const).map((group) => (
        <div key={group} className="mt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            {GROUP_TITLES[group]}
          </h3>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            {FIELDS.filter((f) => f.group === group).map((f) => (
              <label key={f.key} className="block">
                <span className="mb-1.5 block text-sm font-medium">{f.label}</span>
                <input
                  type="number"
                  min={0}
                  step={f.step}
                  inputMode="decimal"
                  value={values[f.key]}
                  onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  className={INPUT_CLS}
                />
                {f.hint && <span className="mt-1 block text-xs text-muted-foreground">{f.hint}</span>}
              </label>
            ))}
          </div>
        </div>
      ))}

      <div className="mt-4">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Availability
        </h3>
        <div className="mt-2 space-y-3 rounded-xl border border-border p-3">
          <label className="flex items-center justify-between gap-3">
            <span>
              <span className="block text-sm font-medium">Pause new orders</span>
              <span className="block text-xs text-muted-foreground">
                Customers see the branch as closed until you resume.
              </span>
            </span>
            <input
              type="checkbox"
              checked={paused}
              onChange={(e) => setPaused(e.target.checked)}
              className="h-5 w-5 accent-primary"
            />
          </label>
          <label className="block">
            <span className="mb-1.5 block text-sm font-medium">Busy mode — extra prep time (min)</span>
            <input
              type="number"
              min={0}
              step="5"
              inputMode="numeric"
              value={busyExtra}
              onChange={(e) => setBusyExtra(e.target.value)}
              className={INPUT_CLS}
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Added to every customer ETA while the kitchen is slammed. 0 = off.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 flex items-center justify-between text-sm font-medium">
              <span>Surge multiplier</span>
              <span className="font-display text-base font-bold text-primary">×{surge.toFixed(2)}</span>
            </span>
            <input
              type="range"
              min={1}
              max={2}
              step={0.05}
              value={surge}
              onChange={(e) => setSurge(Number(e.target.value))}
              className="h-2 w-full accent-primary"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Applied to the delivery fee after the min/max clamp. 1.00 = off.
            </span>
          </label>
        </div>
      </div>

      <div className="mt-4 rounded-xl bg-muted/50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fee preview
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
          {preview.map((p) => (
            <div key={p.km} className="rounded-lg bg-card p-2">
              <p className="text-xs text-muted-foreground">{p.km} km</p>
              {p.inRange ? (
                <>
                  <p className="font-display text-base font-bold text-primary">${p.fee.toFixed(2)}</p>
                  <p className="text-xs text-muted-foreground">~{p.eta} min</p>
                </>
              ) : (
                <p className="mt-1 text-xs font-medium text-muted-foreground">Out of range</p>
              )}
            </div>
          ))}
        </div>
      </div>

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
