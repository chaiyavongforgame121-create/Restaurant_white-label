'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Flame, Pause, Play } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';

// Always-on-screen kitchen controls: pause new orders / busy mode (+prep time).
// They write branches.settings keys — the same keys the delivery settings card and
// is_branch_open()/quote_delivery() consume — through patch_branch_settings, which merges ONLY
// the changed key into the stored settings. This used to write back the whole settings object
// as it was when the board loaded, so a Pause pressed hours later undid every change the owner
// had made in Branch settings since. Styled for the warm "Sunset" header (translucent-white pills
// on the gradient). Surfaces the settings upward so the board can paint a persistent paused
// banner and time scheduled tickets.

const BUSY_OPTIONS = [0, 10, 20, 30];

/** A pause set from the back office, or on another tablet, has to show here too: branches is not
 *  in the realtime publication, so the settings are re-read on this cadence and on tab focus. */
const SETTINGS_POLL_MS = 60_000;

type Settings = Record<string, unknown>;

export function OpsToggles({
  branchId,
  onSettings,
  onError,
}: {
  branchId: string;
  onSettings?: (settings: Settings) => void;
  /** A write was refused or failed; the key names the toast (kitchen.toast.*). */
  onError?: (key: 'settingsFailed' | 'settingsForbidden') => void;
}) {
  const t = useTranslations('kitchen');
  const [settings, setSettings] = React.useState<Settings | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [busyOpen, setBusyOpen] = React.useState(false);
  // Bumped by every write, so a read that started before the write cannot land after it and
  // paint the old value back.
  const writeSeq = React.useRef(0);

  const load = React.useCallback(async () => {
    const seq = writeSeq.current;
    const { data, error } = await getBrowserClient().from('branches').select('settings').eq('id', branchId).single();
    if (error || seq !== writeSeq.current) return;
    setSettings((data?.settings ?? {}) as Settings);
  }, [branchId]);

  React.useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), SETTINGS_POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [load]);

  React.useEffect(() => {
    if (settings) onSettings?.(settings);
  }, [settings, onSettings]);

  const patch = async (changes: Settings) => {
    if (!settings) return;
    writeSeq.current += 1;
    setSaving(true);
    setSettings((curr) => ({ ...(curr ?? {}), ...changes })); // optimistic
    const { data, error } = await getBrowserClient().rpc('patch_branch_settings', {
      p_branch_id: branchId,
      p_patch: changes as never,
    });
    writeSeq.current += 1;
    setSaving(false);
    if (error) {
      console.error('kitchen: patch_branch_settings failed', error.message);
      onError?.(error.message.includes('not_authorized') ? 'settingsForbidden' : 'settingsFailed');
      void load(); // roll back to server truth
      return;
    }
    if (data && typeof data === 'object' && !Array.isArray(data)) setSettings(data as Settings);
  };

  if (!settings) return null;

  const paused = Boolean(settings.orders_paused);
  const busy = Number(settings.busy_extra_prep_min) || 0;
  const pill = 'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium';

  return (
    <>
      <div className="relative">
        <button
          type="button"
          disabled={saving}
          onClick={() => setBusyOpen((o) => !o)}
          className={pill}
          style={busy > 0 ? { background: '#fff', color: '#C2491F' } : { background: 'rgba(255,255,255,.22)', color: '#fff' }}
          title={t('ops.busyHint')}
        >
          <Flame className="h-4 w-4" />{busy > 0 ? t('ops.busyMinutes', { minutes: busy }) : t('ops.busy')}
        </button>
        {busyOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setBusyOpen(false)} />
            <div className="absolute right-0 top-10 z-20 flex gap-1 rounded-xl p-1.5" style={{ background: '#fff', border: '1px solid rgba(170,100,55,.16)', boxShadow: '0 8px 24px rgba(0,0,0,.14)' }}>
              {BUSY_OPTIONS.map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => { void patch({ busy_extra_prep_min: m }); setBusyOpen(false); }}
                  className="whitespace-nowrap rounded-lg px-3 py-1.5 text-xs font-medium"
                  style={m === busy ? { background: '#FF6B2C', color: '#fff' } : { background: '#F3E9E0', color: '#5A4636' }}
                >
                  {m === 0 ? t('ops.off') : t('ops.plusMinutes', { minutes: m })}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <button
        type="button"
        disabled={saving}
        onClick={() => void patch({ orders_paused: !paused })}
        className={pill}
        style={paused ? { background: '#fff', color: '#C0382F' } : { background: 'rgba(255,255,255,.22)', color: '#fff' }}
        title={t('ops.pauseHint')}
      >
        {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{paused ? t('ops.resume') : t('ops.pause')}
      </button>
    </>
  );
}
