'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { AlertTriangle, Lock, Save, Wallet } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, Card } from '@favornoms/ui';

// Editor for the payment_methods key inside branches.settings (jsonb).
// Saves independently from the main BranchSettings form — merges keys, never
// clobbers unrelated settings. Absent key/subkey means ENABLED, so existing
// branches keep accepting everything until staff opt out.
//
// Card is additionally gated on the card_payment entitlement. Without it the
// toggles are locked OFF and read-only: the branches.settings write itself is
// ungated (it is the merchant's own row), so leaving the switch live would let
// a restaurant advertise a payment method that place-order then refuses with a
// 403 at checkout — the worst possible place to discover it.

interface Props {
  branchId: string;
  settings: Record<string, unknown>;
  canUseCard: boolean;
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

export function PaymentMethodsCard({ branchId, settings, canUseCard }: Props) {
  const router = useRouter();
  const [matrix, setMatrix] = React.useState<PaymentMatrix>(() => {
    const seeded = seedFromSettings(settings);
    if (canUseCard) return seeded;
    return {
      asap: { ...seeded.asap, card: false },
      scheduled: { ...seeded.scheduled, card: false },
    };
  });
  const [saving, setSaving] = React.useState(false);
  const [savedAt, setSavedAt] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // With card locked off, "no method enabled" would fire for every branch that
  // has cash off — which is the real warning, so it still applies.
  const deadModes = MODES.filter((m) => !matrix[m.key].cash && !matrix[m.key].card);

  const toggle = (mode: Mode, method: Method) => {
    if (method === 'card' && !canUseCard) return;
    setMatrix((v) => ({ ...v, [mode]: { ...v[mode], [method]: !v[mode][method] } }));
  };

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
          {METHODS.map((method) => {
            const locked = method.key === 'card' && !canUseCard;
            return (
              <React.Fragment key={method.key}>
                <span className={locked ? 'opacity-60' : undefined}>
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {method.label}
                    {locked && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {locked ? 'Not included in your package' : method.hint}
                  </span>
                </span>
                {MODES.map((m) => (
                  <span key={m.key} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${method.label} for ${m.label} orders`}
                      checked={matrix[m.key][method.key]}
                      disabled={locked}
                      onChange={() => toggle(m.key, method.key)}
                      className="h-5 w-5 accent-primary disabled:opacity-40"
                    />
                  </span>
                ))}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {!canUseCard && (
        <p className="mt-3 flex flex-wrap items-center gap-2 rounded-xl bg-muted px-4 py-3 text-sm">
          <Lock className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span>Card payment is not included in your current package.</span>
          <Link
            href={`/b/${branchId}/settings/plan`}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            View packages
          </Link>
        </p>
      )}

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
