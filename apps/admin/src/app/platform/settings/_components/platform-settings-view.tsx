'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
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

/** Platform feature flags, by settings key. The label is looked up as settings.flags.<key>. */
const FEATURE_FLAGS: Array<keyof PlatformSettings['features']> = ['combos', 'giftCards'];

/** Raw PostgREST text is for the logs, never the screen. */
function saveErrorKey(raw: string): string {
  console.error('[platform/settings] update_platform_settings failed:', raw);
  if (/forbidden|not[ _]authori[sz]ed|permission denied|platform[ _]admin/i.test(raw)) {
    return 'errors.permission';
  }
  if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(raw)) {
    return 'errors.network';
  }
  return 'errors.saveFailed';
}

export function PlatformSettingsView({ initial }: { initial: Record<string, unknown> }) {
  const router = useRouter();
  const t = useTranslations('platformBilling');
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
      setError(t(saveErrorKey(rpcErr.message)));
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
        <h1 className="font-display text-3xl font-bold">{t('settings.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('settings.subtitle')}</p>
      </header>
      <PlatformNav />

      {/* Driver penalty */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Ban className="h-5 w-5 text-primary" /> {t('settings.penalty.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('settings.penalty.description')}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {numField(
            t('settings.penalty.threshold'),
            s.penalty.threshold,
            (n) => setPenalty({ threshold: n }),
            { min: 1, hint: t('settings.penalty.thresholdHint') },
          )}
          {numField(
            t('settings.penalty.window'),
            s.penalty.windowHours,
            (n) => setPenalty({ windowHours: n }),
            { min: 1, hint: t('settings.penalty.windowHint') },
          )}
          {numField(
            t('settings.penalty.cooldown'),
            s.penalty.cooldownMinutes,
            (n) => setPenalty({ cooldownMinutes: n }),
            { min: 1, hint: t('settings.penalty.cooldownHint') },
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
            {t('settings.penalty.countRejects')}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={s.penalty.countTimeouts}
              onChange={(e) => setPenalty({ countTimeouts: e.target.checked })}
              className="h-5 w-5 accent-primary"
            />
            {t('settings.penalty.countTimeouts')}
          </label>
        </div>
      </Card>

      {/* Tip policy */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <ShieldAlert className="h-5 w-5 text-primary" /> {t('settings.tips.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('settings.tips.description')}</p>
        <div className="mt-4">
          <Segmented<TipMode>
            value={s.tips.mode}
            onChange={(mode) => setS((v) => ({ ...v, tips: { mode } }))}
            options={[
              { value: 'hidden', label: t('settings.tips.hidden') },
              { value: 'transparent', label: t('settings.tips.transparent') },
            ]}
          />
        </div>
        {s.tips.mode === 'hidden' && (
          <div className="mt-4 flex gap-3 rounded-xl bg-warning/10 p-4 text-sm text-foreground">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
            <div>
              <p className="font-semibold text-foreground">{t('settings.tips.legalTitle')}</p>
              <p className="mt-1 text-muted-foreground">{t('settings.tips.legalBody')}</p>
            </div>
          </div>
        )}
      </Card>

      {/* New-branch defaults */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Sliders className="h-5 w-5 text-primary" /> {t('settings.defaults.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('settings.defaults.description')}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {numField(
            t('settings.defaults.deliveryRadius'),
            s.defaults.deliveryRadiusMi,
            (n) => setDefaults({ deliveryRadiusMi: n }),
            { step: '0.5' },
          )}
          {numField(
            t('settings.defaults.driverSearchRadius'),
            s.defaults.driverSearchRadiusMi,
            (n) => setDefaults({ driverSearchRadiusMi: n }),
            { step: '0.5' },
          )}
          {numField(
            t('settings.defaults.driverBasePay'),
            s.defaults.driverBasePay,
            (n) => setDefaults({ driverBasePay: n }),
            { step: '0.01' },
          )}
          {numField(
            t('settings.defaults.driverPerMile'),
            s.defaults.driverPerMilePay,
            (n) => setDefaults({ driverPerMilePay: n }),
            { step: '0.01' },
          )}
        </div>
      </Card>

      {/* Feature flags */}
      <Card className="mb-6 p-5">
        <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
          <Flag className="h-5 w-5 text-primary" /> {t('settings.flags.title')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('settings.flags.description')}</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {FEATURE_FLAGS.map((key) => (
            <label
              key={key}
              className="flex items-center justify-between gap-3 rounded-xl border border-border p-3"
            >
              <span className="text-sm font-medium">{t(`settings.flags.${key}`)}</span>
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
          {t('settings.save')}
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">{t('settings.saved')}</span>}
        <button
          type="button"
          onClick={() => setS(PLATFORM_SETTING_DEFAULTS)}
          className="text-sm text-muted-foreground underline-offset-2 hover:underline"
        >
          {t('settings.reset')}
        </button>
      </div>
    </div>
  );
}
