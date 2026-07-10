'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Save, ShieldAlert, Sliders, Ban, Flag } from 'lucide-react';
import {
  PLATFORM_SETTING_DEFAULTS,
  parsePlatformSettings,
  serializePlatformSettings,
  type PlatformSettings,
  type TipMode,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card, Segmented } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

export function PlatformSettingsView({ initial }: { initial: Record<string, unknown> }) {
  const router = useRouter();
  const [s, setS] = React.useState<PlatformSettings>(() => parsePlatformSettings(initial));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const setPenalty = (patch: Partial<PlatformSettings['penalty']>) =>
    setS((v) => ({ ...v, penalty: { ...v.penalty, ...patch } }));
  const setDefaults = (patch: Partial<PlatformSettings['defaults']>) =>
    setS((v) => ({ ...v, defaults: { ...v.defaults, ...patch } }));
  const setFeature = (key: keyof PlatformSettings['features'], val: boolean) =>
    setS((v) => ({ ...v, features: { ...v.features, [key]: val } }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('update_platform_settings', {
      p_patch: serializePlatformSettings(s) as never,
    });
    setSaving(false);
    if (rpcErr) {
      setError(rpcErr.message);
      return;
    }
    setSavedAt(Date.now());
    router.refresh();
  };

  const numField = (
    label: string,
    value: number,
    onChange: (n: number) => void,
    opts?: { step?: string; hint?: string; min?: number },
  ) => (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      <input
        type="number"
        min={opts?.min ?? 0}
        step={opts?.step ?? '1'}
        inputMode="decimal"
        value={String(value)}
        onChange={(e) => onChange(Number(e.target.value))}
        className={INPUT_CLS}
      />
      {opts?.hint && <span className="mt-1 block text-xs text-muted-foreground">{opts.hint}</span>}
    </label>
  );

  return (
    <div className="container max-w-4xl py-8">
      <header className="mb-2">
        <h1 className="font-display text-3xl font-bold">Platform settings</h1>
        <p className="mt-1 text-muted-foreground">
          Global configuration for every restaurant on the platform.
        </p>
      </header>
      <PlatformNav />

      {/* Driver penalty */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Ban className="h-5 w-5 text-primary" /> Driver penalty
        </h2>
        <p className="text-sm text-muted-foreground">
          When a driver racks up too many rejects/timeouts in the rolling window, they&apos;re
          blocked from going online for the cooldown period.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {numField('Threshold (events)', s.penalty.threshold, (n) => setPenalty({ threshold: n }), {
            min: 1,
            hint: 'Events in the window before a block',
          })}
          {numField('Window (hours)', s.penalty.windowHours, (n) => setPenalty({ windowHours: n }), {
            min: 1,
            hint: 'Rolling lookback period',
          })}
          {numField(
            'Cooldown (minutes)',
            s.penalty.cooldownMinutes,
            (n) => setPenalty({ cooldownMinutes: n }),
            { min: 1, hint: 'How long the block lasts' },
          )}
        </div>
        <div className="mt-3 flex flex-wrap gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.penalty.countRejects}
              onChange={(e) => setPenalty({ countRejects: e.target.checked })}
              className="h-5 w-5 accent-primary"
            />
            Count explicit rejects
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.penalty.countTimeouts}
              onChange={(e) => setPenalty({ countTimeouts: e.target.checked })}
              className="h-5 w-5 accent-primary"
            />
            Count offer timeouts (no action)
          </label>
        </div>
      </Card>

      {/* Tip policy */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <ShieldAlert className="h-5 w-5 text-primary" /> Delivery tip visibility
        </h2>
        <p className="text-sm text-muted-foreground">
          Controls what a driver sees about the tip on a delivery offer.
        </p>
        <div className="mt-4">
          <Segmented<TipMode>
            value={s.tips.mode}
            onChange={(mode) => setS((v) => ({ ...v, tips: { mode } }))}
            options={[
              { value: 'hidden', label: 'Hidden (net only)' },
              { value: 'transparent', label: 'Transparent' },
            ]}
          />
        </div>
        {s.tips.mode === 'hidden' && (
          <div className="mt-4 flex gap-3 rounded-xl bg-warning/10 p-4 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="font-semibold text-foreground">Legal review recommended</p>
              <p className="mt-1 text-muted-foreground">
                Hiding the restaurant&apos;s tip cut from drivers may conflict with US tip law
                (FLSA) and tip-transparency rules in states/cities such as CA, NY, and Seattle,
                especially for W-2 drivers. Confirm with counsel before enabling in production.
              </p>
            </div>
          </div>
        )}
      </Card>

      {/* New-branch defaults */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Sliders className="h-5 w-5 text-primary" /> New-branch delivery defaults
        </h2>
        <p className="text-sm text-muted-foreground">
          Seed values applied when a new branch is created. Branches can override these later. All
          distances/rates are in miles.
        </p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {numField(
            'Delivery radius (mi)',
            s.defaults.deliveryRadiusMi,
            (n) => setDefaults({ deliveryRadiusMi: n }),
            { step: '0.5' },
          )}
          {numField(
            'Driver search radius (mi)',
            s.defaults.driverSearchRadiusMi,
            (n) => setDefaults({ driverSearchRadiusMi: n }),
            { step: '0.5' },
          )}
          {numField(
            'Driver base pay ($)',
            s.defaults.driverBasePay,
            (n) => setDefaults({ driverBasePay: n }),
            { step: '0.01' },
          )}
          {numField(
            'Driver per mile ($)',
            s.defaults.driverPerMilePay,
            (n) => setDefaults({ driverPerMilePay: n }),
            { step: '0.01' },
          )}
        </div>
      </Card>

      {/* Feature flags */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Flag className="h-5 w-5 text-primary" /> Feature flags
        </h2>
        <p className="text-sm text-muted-foreground">Turn platform features on or off globally.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {(
            [
              ['combos', 'Combos'],
              ['reservations', 'Reservations'],
              ['giftCards', 'Gift cards'],
              ['voiceOrder', 'Voice ordering'],
            ] as Array<[keyof PlatformSettings['features'], string]>
          ).map(([key, label]) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <span className="text-sm font-medium">{label}</span>
              <input
                type="checkbox"
                checked={s.features[key]}
                onChange={(e) => setFeature(key, e.target.checked)}
                className="h-5 w-5 accent-primary"
              />
            </label>
          ))}
        </div>
      </Card>

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save platform settings
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
        <button
          type="button"
          onClick={() => setS(PLATFORM_SETTING_DEFAULTS)}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}
