'use client';

import * as React from 'react';
import { Flame, Pause, Play } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';

// Always-on-screen kitchen controls: pause new orders / busy mode (+prep time).
// Writes merge into branches.settings — same keys the delivery settings card and
// is_branch_open()/quote_delivery() consume. Styled for the warm "Sunset" header
// (translucent-white pills on the gradient). Surfaces `orders_paused` upward so
// the board can paint a persistent paused banner.

const BUSY_OPTIONS = [0, 10, 20, 30];

export function OpsToggles({ branchId, onPaused }: { branchId: string; onPaused?: (paused: boolean) => void }) {
  const [settings, setSettings] = React.useState<Record<string, unknown> | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [busyOpen, setBusyOpen] = React.useState(false);

  const load = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase.from('branches').select('settings').eq('id', branchId).single();
    setSettings((data?.settings ?? {}) as Record<string, unknown>);
  }, [branchId]);

  React.useEffect(() => { void load(); }, [load]);

  React.useEffect(() => {
    if (settings) onPaused?.(Boolean(settings.orders_paused));
  }, [settings, onPaused]);

  const patch = async (changes: Record<string, unknown>) => {
    if (!settings) return;
    setSaving(true);
    const next = { ...settings, ...changes };
    setSettings(next); // optimistic
    const supabase = getBrowserClient();
    const { error } = await supabase.from('branches').update({ settings: next }).eq('id', branchId);
    setSaving(false);
    if (error) void load(); // roll back to server truth
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
          title="Adds prep time to every customer ETA"
        >
          <Flame className="h-4 w-4" />{busy > 0 ? `Busy +${busy}m` : 'Busy'}
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
                  className="rounded-lg px-3 py-1.5 text-xs font-medium"
                  style={m === busy ? { background: '#FF6B2C', color: '#fff' } : { background: '#F3E9E0', color: '#5A4636' }}
                >
                  {m === 0 ? 'Off' : `+${m}m`}
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
        title="Customers see the branch as closed while paused"
      >
        {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}{paused ? 'Resume' : 'Pause'}
      </button>
    </>
  );
}
