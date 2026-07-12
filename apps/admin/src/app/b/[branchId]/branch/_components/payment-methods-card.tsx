'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { AlertTriangle, Save, Wallet } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Editor for the payment_methods key inside branches.settings (jsonb).
// Saves independently from the main BranchSettings form — merges keys, never
// clobbers unrelated settings. Absent key/subkey means ENABLED, so existing
// branches keep accepting everything until staff opt out.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
}

type Mode = 'asap' | 'scheduled';
type Method = 'cash' | 'card';

const MODES: Array<{ key: Mode; label: string }> = [
  { key: 'asap', label: 'ASAP' },
  { key: 'scheduled', label: 'Scheduled' },
];

const METHODS: Array<{ key: Method; label: string; hint: string }> = [
  { key: 'cash', label: 'Cash', hint: 'Paid to the driver or at the counter' },
  { key: 'card', label: 'Card', hint: 'Collected at handoff with your own reader' },
];

type PaymentMatrix = Record<Mode, Record<Method, boolean>>;

function seedFromSettings(settings: Record<string, unknown>): PaymentMatrix {
  const raw = settings?.payment_methods as
    | Partial<Record<Mode, Partial<Record<Method, unknown>>>>
    | undefined;
  const read = (mode: Mode, method: Method) => {
    const v = raw?.[mode]?.[method];
    return typeof v === 'boolean' ? v : true;
  };
  return {
    asap: { cash: read('asap', 'cash'), card: read('asap', 'card') },
    scheduled: { cash: read('scheduled', 'cash'), card: read('scheduled', 'card') },
  };
}

export function PaymentMethodsCard({ branchId, settings }: Props) {
  const router = useRouter();
  const [matrix, setMatrix] = React.useState<PaymentMatrix>(() => seedFromSettings(settings));
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const deadModes = MODES.filter((m) => !matrix[m.key].cash && !matrix[m.key].card);

  const toggle = (mode: Mode, method: Method) =>
    setMatrix((v) => ({ ...v, [mode]: { ...v[mode], [method]: !v[mode][method] } }));

  const save = async () => {
    setSaving(true);
    setError(null);
    const supabase = getBrowserClient();
    // Merge into the existing jsonb — other settings keys stay untouched.
    const { error: updateError } = await supabase
      .from('branches')
      .update({ settings: { ...settings, payment_methods: matrix } })
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
        <Wallet className="h-5 w-5 text-primary" /> Payment methods
      </h2>
      <p className="text-sm text-muted-foreground">
        Choose which payment methods customers can pick for ASAP and scheduled orders. Card
        payments are collected by you at handoff with your own reader — nothing is charged online
        yet. Orders your staff take at the counter or POS are not affected.
      </p>

      <div className="mt-4 rounded-xl border border-border p-3">
        <div className="grid grid-cols-[1fr_auto_auto] items-center gap-x-6 gap-y-3">
          <span />
          {MODES.map((m) => (
            <span
              key={m.key}
              className="text-center text-xs font-semibold uppercase tracking-wider text-muted-foreground"
            >
              {m.label}
            </span>
          ))}
          {METHODS.map((method) => (
            <React.Fragment key={method.key}>
              <span>
                <span className="block text-sm font-medium">{method.label}</span>
                <span className="block text-xs text-muted-foreground">{method.hint}</span>
              </span>
              {MODES.map((m) => (
                <span key={m.key} className="text-center">
                  <input
                    type="checkbox"
                    aria-label={`${method.label} for ${m.label} orders`}
                    checked={matrix[m.key][method.key]}
                    onChange={() => toggle(m.key, method.key)}
                    className="h-5 w-5 accent-primary"
                  />
                </span>
              ))}
            </React.Fragment>
          ))}
        </div>
      </div>

      {deadModes.length > 0 && (
        <p className="mt-3 flex items-start gap-2 rounded-xl bg-warning/10 px-4 py-3 text-sm text-foreground">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
          <span>
            {deadModes.map((m) => m.label).join(' and ')} orders have no payment method enabled —
            customers won&apos;t be able to place {deadModes.length > 1 ? 'those' : 'that kind of'}{' '}
            order{deadModes.length > 1 ? 's' : ''}.
          </span>
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="mt-4 flex items-center gap-3">
        <Button onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          Save payment methods
        </Button>
        {savedAt && !saving && <span className="text-sm text-success">Saved ✓</span>}
      </div>
    </Card>
  );
}
