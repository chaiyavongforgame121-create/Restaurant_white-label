'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Percent, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Structured editor for branches.settings.service_fee_percent (jsonb). Saves
// independently from the main BranchSettings form — merges the one key, never
// clobbers unrelated settings.
//
// service_fee_percent is the SAME key the authoritative pricing already reads:
// supabase/functions/place-order applies `subtotal * service_fee_percent / 100`
// and defaults to 0 when unset. Blank/0 here means "no service fee" end to end.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

const INPUT_CLS =
  'h-12 w-full rounded-xl border border-border bg-background px-4 text-base outline-none transition-colors focus-visible:border-primary';

const PREVIEW_SUBTOTALS = [20, 40, 80];
const MAX_PCT = 25;

export function ServiceFeeCard({ branchId, settings }: Props) {
  const router = useRouter();
  const [percent, setPercent] = React.useState<string>(() => {
    const n = Number(settings?.service_fee_percent);
    return Number.isFinite(n) && n >= 0 ? String(n) : '0';
  });
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // Empty input reads as 0 rather than NaN, so clearing the box is a valid way
  // to turn the fee off.
  const parsed = React.useMemo(() => {
    const n = Number(percent);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.min(MAX_PCT, n);
  }, [percent]);

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, service_fee_percent: parsed } })
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
        <Percent className="h-5 w-5 text-primary" /> Service fee
      </h2>
      <p className="text-sm text-muted-foreground">
        A percentage of the food subtotal added at checkout, on every order type. Set it to{' '}
        <strong>0</strong> to charge no service fee at all.
      </p>

      <div className="mt-4 max-w-xs">
        <label className="block">
          <span className="mb-1.5 block text-sm font-medium">Service fee (%)</span>
          <input
            type="number"
            min={0}
            max={MAX_PCT}
            step="0.5"
            inputMode="decimal"
            value={percent}
            onChange={(e) => setPercent(e.target.value)}
            className={INPUT_CLS}
          />
          <span className="mt-1 block text-xs text-muted-foreground">
            0 – {MAX_PCT}%. Charged on the subtotal only — never on tax, tips or the delivery fee.
          </span>
        </label>
      </div>

      <div className="mt-4 rounded-xl bg-muted/50 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Fee preview
        </p>
        <div className="mt-2 grid grid-cols-3 gap-2 text-center text-sm">
          {PREVIEW_SUBTOTALS.map((s) => (
            <div key={s} className="rounded-lg bg-card p-2">
              <p className="text-xs text-muted-foreground">${s} order</p>
              <p className="font-display text-base font-bold text-primary">
                ${(Math.round(s * parsed) / 100).toFixed(2)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save service fee
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
    </Card>
  );
}
