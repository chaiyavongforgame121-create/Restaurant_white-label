'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Coins, Save } from 'lucide-react';
import {
  distributeTip,
  parseTipConfig,
  serializeTipConfig,
  type TipChannel,
  type TipConfig,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Structured editor for branches.settings.tip_config (jsonb). Saves independently
// from the main BranchSettings form — merges the tip_config key, never clobbers
// unrelated settings. The distribution math mirrors the SQL trigger
// orders_on_complete_record_tip_split() (see migration `tip_config_and_ledger`).

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

// The customer web cart only offers delivery / pickup / dine_in; qr_ordering
// reuses the dine_in policy, so we surface these three here.
const EDITABLE: Array<{ channel: Exclude<TipChannel, 'qr_ordering'>; label: string; worker: string }> = [
  { channel: 'delivery', label: 'Delivery', worker: 'Driver' },
  { channel: 'pickup', label: 'Pickup', worker: 'Staff pool' },
  { channel: 'dine_in', label: 'Dine-in', worker: 'Staff pool' },
];

export function TipSettingsCard({ branchId, settings }: Props) {
  const router = useRouter();
  const [config, setConfig] = React.useState<TipConfig>(() => parseTipConfig(settings));
  const [presetText, setPresetText] = React.useState<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const parsed = parseTipConfig(settings);
    for (const e of EDITABLE) out[e.channel] = parsed[e.channel].presets.join(', ');
    return out;
  });
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const setWorkerPct = (channel: TipChannel, pct: number) =>
    setConfig((c) => ({
      ...c,
      [channel]: { ...c[channel], workerPct: Math.max(0, Math.min(100, pct)) },
    }));

  const parsePresetText = (text: string): number[] => {
    const nums = text
      .split(/[\s,]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n >= 0 && n <= 100)
      .map((n) => Math.round(n));
    return nums.length > 0 ? Array.from(new Set(nums)) : [0];
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    // Fold edited preset text into config; keep qr_ordering aligned with dine_in.
    const next: TipConfig = { ...config };
    for (const e of EDITABLE) {
      next[e.channel] = {
        presets: parsePresetText(presetText[e.channel] ?? ''),
        workerPct: config[e.channel].workerPct,
      };
    }
    next.qr_ordering = { ...next.dine_in };
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, tip_config: serializeTipConfig(next) } })
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
        <Coins className="h-5 w-5 text-primary" /> Tips
      </h2>
      <p className="text-sm text-muted-foreground">
        Preset tip percentages shown at checkout, and how each tip is split between the
        worker and the house. On delivery the worker is the driver; on pickup and dine-in
        it&apos;s the staff pool.
      </p>

      <div className="mt-4 space-y-4">
        {EDITABLE.map((e) => {
          const worker = config[e.channel].workerPct;
          const example = distributeTip(config, e.channel, 10);
          return (
            <div key={e.channel} className="rounded-xl border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {e.label}
              </h3>
              <label className="mt-2 block">
                <span className="mb-1.5 block text-sm font-medium">Preset % buttons</span>
                <input
                  value={presetText[e.channel] ?? ''}
                  onChange={(ev) => setPresetText((p) => ({ ...p, [e.channel]: ev.target.value }))}
                  placeholder="0, 5, 10, 15"
                  inputMode="numeric"
                  className={INPUT_CLS}
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  Comma-separated. Include 0 to show a &ldquo;None&rdquo; button.
                </span>
              </label>
              <label className="mt-3 block">
                <span className="mb-1.5 flex items-center justify-between text-sm font-medium">
                  <span>{e.worker} share</span>
                  <span className="font-display text-base font-bold text-primary">
                    {worker}% {e.worker.toLowerCase()} &middot; {100 - worker}% house
                  </span>
                </span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={5}
                  value={worker}
                  onChange={(ev) => setWorkerPct(e.channel, Number(ev.target.value))}
                  className="h-2 w-full accent-primary"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  On a $10 tip:{' '}
                  {e.channel === 'delivery'
                    ? `driver $${example.driverCut.toFixed(2)}`
                    : `staff $${example.staffCut.toFixed(2)}`}
                  , house ${example.houseCut.toFixed(2)}.
                </span>
              </label>
            </div>
          );
        })}
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save tip settings
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
    </Card>
  );
}
