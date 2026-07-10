'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { Plus, Save } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { PlatformNav } from '../../_components/platform-nav';

export interface PlanRow {
  code: string;
  name: string;
  monthly_price: number | string;
  limits: { max_items?: number; max_branches?: number; max_orders_per_month?: number };
  is_active: boolean;
}

interface Draft {
  code: string;
  name: string;
  monthly_price: string;
  max_branches: string;
  max_items: string;
  max_orders_per_month: string;
  is_active: boolean;
}

const INPUT_CLS =
  'h-11 w-full rounded-xl border border-border bg-background px-3 text-base outline-none transition-colors focus-visible:border-primary';

// -1 means "unlimited" throughout the plan-limit system.
const toDraft = (p: PlanRow): Draft => ({
  code: p.code,
  name: p.name,
  monthly_price: String(Number(p.monthly_price)),
  max_branches: String(p.limits?.max_branches ?? -1),
  max_items: String(p.limits?.max_items ?? -1),
  max_orders_per_month: String(p.limits?.max_orders_per_month ?? -1),
  is_active: p.is_active,
});

const EMPTY_DRAFT: Draft = {
  code: '',
  name: '',
  monthly_price: '0',
  max_branches: '1',
  max_items: '100',
  max_orders_per_month: '1000',
  is_active: true,
};

export function PlansManager({ plans }: { plans: PlanRow[] }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [creating, setCreating] = React.useState(false);

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-3xl font-bold">Subscription plans</h1>
          <p className="mt-1 text-muted-foreground">
            Pricing and feature limits offered to restaurants. Use −1 for unlimited.
          </p>
        </div>
        {!creating && (
          <Button leftIcon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
            New plan
          </Button>
        )}
      </header>
      <PlatformNav />

      {error && (
        <p className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</p>
      )}

      <div className="space-y-4">
        {creating && (
          <PlanEditor
            key="__new__"
            initial={EMPTY_DRAFT}
            isNew
            onCancel={() => setCreating(false)}
            onError={setError}
            onSaved={() => {
              setCreating(false);
              router.refresh();
            }}
          />
        )}
        {plans.map((p) => (
          <PlanEditor
            key={p.code}
            initial={toDraft(p)}
            onError={setError}
            onSaved={() => router.refresh()}
          />
        ))}
      </div>
    </div>
  );
}

function PlanEditor({
  initial,
  isNew,
  onSaved,
  onError,
  onCancel,
}: {
  initial: Draft;
  isNew?: boolean;
  onSaved: () => void;
  onError: (msg: string | null) => void;
  onCancel?: () => void;
}) {
  const [d, setD] = React.useState<Draft>(initial);
  const [saving, setSaving] = React.useState(false);
  const set = (patch: Partial<Draft>) => setD((v) => ({ ...v, ...patch }));

  const save = async () => {
    onError(null);
    if (isNew && !d.code.trim()) {
      onError('Plan code is required.');
      return;
    }
    setSaving(true);
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('upsert_subscription_plan', {
      p_code: d.code.trim().toLowerCase(),
      p_name: d.name.trim() || d.code,
      p_monthly_price: Number(d.monthly_price) || 0,
      p_limits: {
        max_branches: Math.trunc(Number(d.max_branches)),
        max_items: Math.trunc(Number(d.max_items)),
        max_orders_per_month: Math.trunc(Number(d.max_orders_per_month)),
      } as never,
      p_is_active: d.is_active,
    });
    setSaving(false);
    if (error) {
      onError(error.message);
      return;
    }
    onSaved();
  };

  const toggleActive = async () => {
    onError(null);
    const next = !d.is_active;
    set({ is_active: next });
    const supabase = getBrowserClient();
    const { error } = await supabase.rpc('set_subscription_plan_active', {
      p_code: d.code,
      p_active: next,
    });
    if (error) {
      onError(error.message);
      set({ is_active: !next });
    }
  };

  const field = (label: string, key: keyof Draft, opts?: { step?: string; type?: string }) => (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-muted-foreground">{label}</span>
      <input
        type={opts?.type ?? 'number'}
        step={opts?.step}
        value={String(d[key])}
        onChange={(e) => set({ [key]: e.target.value } as Partial<Draft>)}
        className={INPUT_CLS}
      />
    </label>
  );

  return (
    <Card className={`p-5 ${!d.is_active ? 'opacity-70' : ''}`}>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-mono text-sm font-semibold">
            {isNew ? 'new plan' : d.code}
          </span>
          {!d.is_active && <Badge variant="muted">Inactive</Badge>}
        </div>
        {!isNew && (
          <button
            type="button"
            onClick={toggleActive}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            {d.is_active ? 'Deactivate' : 'Activate'}
          </button>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {isNew && field('Code (slug)', 'code', { type: 'text' })}
        {field('Name', 'name', { type: 'text' })}
        {field('Monthly price ($)', 'monthly_price', { step: '1' })}
        {field('Max branches', 'max_branches', { step: '1' })}
        {field('Max active items', 'max_items', { step: '1' })}
        {field('Max orders / month', 'max_orders_per_month', { step: '1' })}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button size="sm" onClick={save} loading={saving} leftIcon={<Save className="h-4 w-4" />}>
          {isNew ? 'Create plan' : 'Save'}
        </Button>
        {isNew && onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="text-sm text-muted-foreground underline-offset-2 hover:underline"
          >
            Cancel
          </button>
        )}
      </div>
    </Card>
  );
}
