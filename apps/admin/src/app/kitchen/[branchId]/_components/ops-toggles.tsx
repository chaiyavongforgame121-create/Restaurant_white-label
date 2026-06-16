'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';

// Always-on-screen kitchen controls: pause new orders / busy mode (+prep time).
// Writes merge into branches.settings — same keys the delivery settings card
// and is_branch_open()/quote_delivery() consume.

const BUSY_STEPS = [0, 10, 20];

export function OpsToggles({ branchId }: { branchId: string }) {
  const [settings, setSettings] = React.useState<Record<string, unknown> | null>(null);
  const [busySaving, setBusySaving] = React.useState(false);

  const load = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase.from('branches').select('settings').eq('id', branchId).single();
    setSettings((data?.settings ?? {}) as Record<string, unknown>);
  }, [branchId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = async (changes: Record<string, unknown>) => {
    if (!settings) return;
    setBusySaving(true);
    const next = { ...settings, ...changes };
    setSettings(next); // optimistic
    const supabase = getBrowserClient();
    const { error } = await supabase.from('branches').update({ settings: next }).eq('id', branchId);
    setBusySaving(false);
    if (error) void load(); // roll back to server truth
  };

  if (!settings) return null;

  const paused = Boolean(settings.orders_paused);
  const busy = Number(settings.busy_extra_prep_min) || 0;
  const nextBusy = BUSY_STEPS[(BUSY_STEPS.indexOf(BUSY_STEPS.includes(busy) ? busy : 0) + 1) % BUSY_STEPS.length];

  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        disabled={busySaving}
        onClick={() => void patch({ busy_extra_prep_min: nextBusy })}
        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
          busy > 0 ? 'bg-warning/20 text-warning' : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
        title="Adds prep time to every customer ETA"
      >
        {busy > 0 ? `🔥 Busy +${busy}m` : 'Busy mode'}
      </button>
      <button
        type="button"
        disabled={busySaving}
        onClick={() => void patch({ orders_paused: !paused })}
        className={`focus-ring rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
          paused ? 'bg-danger text-white' : 'bg-muted text-muted-foreground hover:bg-muted/70'
        }`}
        title="Customers see the branch as closed while paused"
      >
        {paused ? '⏸ Orders paused — tap to resume' : 'Pause orders'}
      </button>
    </div>
  );
}
