'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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

// The customer web cart only offers delivery / pickup / dine_in; qr_ordering
// reuses the dine_in policy, so we surface these three here. `labelKey` is the
// branchOps tips.channels.<key> message; `worker` picks the driver or staff-pool wording.
const EDITABLE: Array<{
  channel: Exclude<TipChannel, 'qr_ordering'>;
  labelKey: 'delivery' | 'pickup' | 'dineIn';
  worker: 'driver' | 'staff';
}> = [
  { channel: 'delivery', labelKey: 'delivery', worker: 'driver' },
  { channel: 'pickup', labelKey: 'pickup', worker: 'staff' },
  { channel: 'dine_in', labelKey: 'dineIn', worker: 'staff' },
];

/** Raw database text never reaches the merchant: a known refusal gets its own message,
 *  anything else the generic one. */
function saveErrorKey(err: { message: string; code?: string }): string {
  if (err.code === '42501' || err.message === 'forbidden' || err.message.includes('branch_manager_required')) {
    return 'errors.noPermission';
  }
  return 'errors.generic';
}

export function TipSettingsCard({ branchId, settings }: Props) {
  const t = useTranslations('branchOps');
  const router = useRouter();
  const [config, setConfig] = React.useState<TipConfig>(() => parseTipConfig(settings));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const setWorkerPct = (channel: TipChannel, pct: number) =>
    setConfig((c) => ({
      ...c,
      [channel]: { ...c[channel], workerPct: Math.max(0, Math.min(100, pct)) },
    }));

  const save = async () => {
    setSaving(true);
    setError(null);
    // Presets are not merchant-editable — checkout uses a fixed default
    // (18/20/25 plus Custom and No tip); parseTipConfig ignores any presets on
    // the row and serializeTipConfig never writes them, so this write only
    // persists the worker/house split; keep qr_ordering aligned with dine_in.
    const next: TipConfig = { ...config };
    next.qr_ordering = { ...next.dine_in };
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, tip_config: serializeTipConfig(next) } })
      .eq('id', branchId);
    setSaving(false);
    if (updateError) {
      console.error('Saving tip settings failed', updateError);
      setError(t(saveErrorKey(updateError)));
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  return (
    <Card className="p-5">
      <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
        <Coins className="h-5 w-5 text-primary" /> {t('tips.title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('tips.description')}</p>

      <div className="mt-4 space-y-4">
        {EDITABLE.map((e) => {
          const worker = config[e.channel].workerPct;
          const example = distributeTip(config, e.channel, 10);
          return (
            <div key={e.channel} className="rounded-xl border border-border p-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                {t(`tips.channels.${e.labelKey}`)}
              </h3>
              <label className="mt-2 block">
                <span className="mb-1.5 flex items-center justify-between text-sm font-medium">
                  <span>{t('tips.share', { worker: e.worker })}</span>
                  <span className="font-display text-base font-bold text-primary">
                    {t('tips.split', { worker: e.worker, workerPct: worker, housePct: 100 - worker })}
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
                  {t('tips.example', {
                    worker: e.worker,
                    workerCut: (e.channel === 'delivery' ? example.driverCut : example.staffCut).toFixed(2),
                    houseCut: example.houseCut.toFixed(2),
                  })}
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
          {t('tips.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('common.saved')}</span>}
      </div>
    </Card>
  );
}
