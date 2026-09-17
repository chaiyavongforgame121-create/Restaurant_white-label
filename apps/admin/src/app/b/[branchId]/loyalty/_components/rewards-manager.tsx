'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Gift, Pencil, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, EmptyState, IconButton, useConfirm } from '@favornoms/ui';

type Kind = 'percent_off' | 'fixed_off' | 'free_item' | 'free_delivery';

interface Reward {
  id: string;
  restaurant_id: string;
  name: string;
  description: string | null;
  kind: Kind;
  points_cost: number;
  value: number;
  max_discount: number | null;
  menu_item_id: string | null;
  min_subtotal: number;
  is_active: boolean;
  sort_order: number;
}

interface MenuItem { id: string; name: string; price: number; is_active: boolean }

type RewardsT = ReturnType<typeof useTranslations>;

/** Blank form. Kept as a factory so "New reward" always starts clean. */
const emptyDraft = () => ({
  id: null as string | null,
  name: '',
  description: '',
  kind: 'percent_off' as Kind,
  value: '10',
  max_discount: '',
  menu_item_id: '',
  points_cost: '500',
  min_subtotal: '0',
  sort_order: '0',
});

type Draft = ReturnType<typeof emptyDraft>;

export function RewardsManager({
  restaurantId,
  branchId,
  branchCount,
  programCard,
  initialRewards,
  menuItems,
}: {
  restaurantId: string;
  branchId: string;
  branchCount: number;
  /** Rendered under this page’s heading: the two cards are one screen to the merchant. */
  programCard?: React.ReactNode;
  initialRewards: Reward[];
  menuItems: MenuItem[];
}) {
  const t = useTranslations('loyalty');
  const [list, setList] = React.useState(initialRewards);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const confirm = useConfirm();

  const set = <K extends keyof Draft>(key: K, v: Draft[K]) =>
    setDraft((d) => (d ? { ...d, [key]: v } : d));

  const refresh = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('loyalty_rewards')
      .select('*')
      .eq('restaurant_id', restaurantId)
      .order('sort_order', { ascending: true })
      .order('points_cost', { ascending: true });
    if (data) setList(data as Reward[]);
  };

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    // The kind decides which columns may carry a number — the DB enforces the
    // same shape in loyalty_rewards_kind_shape, so sending a stale value from a
    // kind the merchant switched away from would be rejected outright.
    const row = {
      restaurant_id: restaurantId,
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      kind: draft.kind,
      points_cost: Number(draft.points_cost) || 0,
      value: draft.kind === 'percent_off' || draft.kind === 'fixed_off' ? Number(draft.value) || 0 : 0,
      max_discount:
        draft.kind === 'percent_off' && draft.max_discount ? Number(draft.max_discount) : null,
      menu_item_id: draft.kind === 'free_item' ? draft.menu_item_id || null : null,
      min_subtotal: Number(draft.min_subtotal) || 0,
      sort_order: Number(draft.sort_order) || 0,
    };
    const { data, error: err } = draft.id
      ? await supabase.from('loyalty_rewards').update(row).eq('id', draft.id).select('id')
      : await supabase.from('loyalty_rewards').insert(row).select('id');
    setBusy(false);
    if (err) {
      setError(describeError(err.message, t));
      return;
    }
    if (!data?.length) {
      setError(t('rewards.errors.denied'));
      return;
    }
    setDraft(null);
    void refresh();
  };

  // These ask for the affected ids back rather than firing and forgetting. A row
  // RLS refuses is filtered out by the USING clause instead of raising, so a
  // denied pause or delete returns success with zero rows — the button would
  // appear to work, the list would redraw unchanged, and the merchant would
  // report it as "the button does nothing".
  const toggleActive = async (r: Reward) => {
    const supabase = getBrowserClient();
    const { data, error: err } = await supabase
      .from('loyalty_rewards')
      .update({ is_active: !r.is_active })
      .eq('id', r.id)
      .select('id');
    if (err) return setError(describeError(err.message, t));
    if (!data?.length) return setError(t('rewards.errors.denied'));
    setError(null);
    void refresh();
  };

  const remove = async (r: Reward) => {
    if (
      !(await confirm({
        title: t('rewards.deleteDialog.title', { name: r.name }),
        body: t('rewards.deleteDialog.body'),
        confirmLabel: t('rewards.deleteDialog.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    const { data, error: err } = await supabase
      .from('loyalty_rewards')
      .delete()
      .eq('id', r.id)
      .select('id');
    if (err) return setError(describeError(err.message, t));
    if (!data?.length) return setError(t('rewards.errors.denied'));
    setError(null);
    void refresh();
  };

  const edit = (r: Reward) =>
    setDraft({
      id: r.id,
      name: r.name,
      description: r.description ?? '',
      kind: r.kind,
      value: String(r.value ?? 0),
      max_discount: r.max_discount == null ? '' : String(r.max_discount),
      menu_item_id: r.menu_item_id ?? '',
      points_cost: String(r.points_cost),
      min_subtotal: String(r.min_subtotal ?? 0),
      sort_order: String(r.sort_order ?? 0),
    });

  const describeReward = (r: Reward) => {
    if (r.kind === 'percent_off')
      return r.max_discount
        ? t('rewards.describe.percentOffCapped', {
            value: r.value,
            max: formatCurrency(Number(r.max_discount)),
          })
        : t('rewards.describe.percentOff', { value: r.value });
    if (r.kind === 'fixed_off')
      return t('rewards.describe.fixedOff', { amount: formatCurrency(Number(r.value)) });
    if (r.kind === 'free_item') {
      const item = menuItems.find((m) => m.id === r.menu_item_id)?.name;
      return item
        ? t('rewards.describe.freeItem', { item })
        : t('rewards.describe.freeItemElsewhere');
    }
    return t('rewards.describe.freeDelivery');
  };

  const nameMissing = !draft?.name.trim();
  const itemMissing = draft?.kind === 'free_item' && !draft.menu_item_id;

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('rewards.subtitle')}</p>
        </div>
        <Button
          onClick={() => setDraft((d) => (d ? null : emptyDraft()))}
          variant={draft ? 'ghost' : 'gradient'}
          leftIcon={<Plus className="h-4 w-4" />}
        >
          {draft ? t('rewards.cancel') : t('rewards.new')}
        </Button>
      </header>

      {programCard}

      {branchCount > 1 && (
        <p className="mb-4 rounded-2xl bg-muted/50 px-4 py-3 text-sm text-muted-foreground">
          {t.rich('rewards.multiBranch', { strong: (chunks) => <strong>{chunks}</strong> })}
        </p>
      )}

      {draft && (
        <Card className="mb-6 space-y-3 p-5">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t('rewards.fields.name')}>
              <input
                value={draft.name}
                onChange={(e) => set('name', e.target.value)}
                className="input"
                placeholder={t('rewards.fields.namePlaceholder')}
                maxLength={80}
              />
            </Field>
            <Field label={t('rewards.fields.points')}>
              <input
                value={draft.points_cost}
                onChange={(e) => set('points_cost', e.target.value.replace(/\D/g, ''))}
                className="input"
                inputMode="numeric"
              />
            </Field>
            <Field label={t('rewards.fields.kind')}>
              <select
                value={draft.kind}
                onChange={(e) => set('kind', e.target.value as Kind)}
                className="input"
              >
                <option value="percent_off">{t('rewards.kinds.percent_off')}</option>
                <option value="fixed_off">{t('rewards.kinds.fixed_off')}</option>
                <option value="free_item">{t('rewards.kinds.free_item')}</option>
                <option value="free_delivery">{t('rewards.kinds.free_delivery')}</option>
              </select>
            </Field>
            {(draft.kind === 'percent_off' || draft.kind === 'fixed_off') && (
              <Field
                label={
                  draft.kind === 'percent_off'
                    ? t('rewards.fields.percent')
                    : t('rewards.fields.amount')
                }
              >
                <input
                  value={draft.value}
                  onChange={(e) => set('value', e.target.value.replace(/[^0-9.]/g, ''))}
                  className="input"
                  inputMode="decimal"
                />
              </Field>
            )}
            {draft.kind === 'percent_off' && (
              <Field label={t('rewards.fields.cap')}>
                <input
                  value={draft.max_discount}
                  onChange={(e) => set('max_discount', e.target.value.replace(/[^0-9.]/g, ''))}
                  className="input"
                  inputMode="decimal"
                  placeholder={t('rewards.fields.capPlaceholder')}
                />
              </Field>
            )}
            {draft.kind === 'free_item' && (
              <Field label={t('rewards.fields.item')}>
                <select
                  value={draft.menu_item_id}
                  onChange={(e) => set('menu_item_id', e.target.value)}
                  className="input"
                >
                  <option value="">{t('rewards.fields.itemPlaceholder')}</option>
                  {menuItems.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.is_active
                        ? t('rewards.fields.itemOption', {
                            name: m.name,
                            price: formatCurrency(Number(m.price)),
                          })
                        : t('rewards.fields.itemOptionHidden', {
                            name: m.name,
                            price: formatCurrency(Number(m.price)),
                          })}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            <Field label={t('rewards.fields.minSubtotal')}>
              <input
                value={draft.min_subtotal}
                onChange={(e) => set('min_subtotal', e.target.value.replace(/[^0-9.]/g, ''))}
                className="input"
                inputMode="decimal"
              />
            </Field>
            <Field label={t('rewards.fields.sortOrder')}>
              <input
                value={draft.sort_order}
                onChange={(e) => set('sort_order', e.target.value.replace(/[^0-9-]/g, ''))}
                className="input"
                inputMode="numeric"
              />
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('rewards.fields.description')}>
                <input
                  value={draft.description}
                  onChange={(e) => set('description', e.target.value)}
                  className="input"
                  placeholder={t('rewards.fields.descriptionPlaceholder')}
                  maxLength={280}
                />
              </Field>
            </div>
          </div>
          {/* `danger` — not `destructive`, which is not a token in this design
              system and renders invisible text. */}
          {error && (
            <p className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">{error}</p>
          )}
          <Button variant="gradient" onClick={save} disabled={nameMissing || itemMissing} loading={busy}>
            {draft.id ? t('rewards.saveChanges') : t('rewards.create')}
          </Button>
        </Card>
      )}

      {list.length === 0 ? (
        <EmptyState
          icon={<Gift className="h-7 w-7" />}
          title={t('rewards.empty.title')}
          description={t('rewards.empty.description')}
        />
      ) : (
        <Card className="divide-y divide-border/40">
          {list.map((r) => (
            <div key={r.id} className="flex items-center justify-between gap-3 p-4">
              <div className="min-w-0">
                <p className="truncate font-display text-lg font-semibold">{r.name}</p>
                <p className="text-xs text-muted-foreground">
                  {Number(r.min_subtotal) > 0
                    ? t('rewards.lineWithMinimum', {
                        points: r.points_cost,
                        reward: describeReward(r),
                        min: formatCurrency(Number(r.min_subtotal)),
                      })
                    : t('rewards.line', { points: r.points_cost, reward: describeReward(r) })}
                </p>
                {r.description && (
                  <p className="mt-0.5 truncate text-xs text-muted-foreground">{r.description}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Badge variant={r.is_active ? 'success' : 'muted'}>
                  {r.is_active ? t('rewards.status.active') : t('rewards.status.paused')}
                </Badge>
                <button
                  onClick={() => toggleActive(r)}
                  className="text-xs text-muted-foreground underline"
                >
                  {r.is_active ? t('rewards.pause') : t('rewards.activate')}
                </button>
                <IconButton label={t('rewards.edit')} size="sm" onClick={() => edit(r)}>
                  <Pencil className="h-4 w-4" />
                </IconButton>
                <IconButton label={t('rewards.delete')} size="sm" className="text-danger" onClick={() => remove(r)}>
                  <Trash2 className="h-4 w-4" />
                </IconButton>
              </div>
            </div>
          ))}
        </Card>
      )}

      <p className="mt-4 px-2 text-xs text-muted-foreground lg:px-0">
        {t.rich('rewards.footer', {
          link: (chunks) => (
            <a className="underline" href={`/b/${branchId}/customers`}>
              {chunks}
            </a>
          ),
        })}
      </p>

      <style jsx>{`
        .input { width: 100%; min-height: 48px; padding: 0 1rem; font-size: 16px; border-radius: 0.875rem; border: 1px solid hsl(var(--border)); background: hsl(var(--background)); }
        .input:focus-visible { outline: none; border-color: hsl(var(--primary)); box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18); }
      `}</style>
    </div>
  );
}

/**
 * The database constraints are the real validation, so their names are what a
 * merchant would otherwise be shown. Translate the ones they can actually hit;
 * anything else gets a plain retry message and the raw text goes to the console.
 */
function describeError(message: string, t: RewardsT): string {
  if (message.includes('loyalty_reward_menu_item_foreign'))
    return t('rewards.errors.menuItemForeign');
  if (message.includes('loyalty_rewards_kind_shape'))
    return t('rewards.errors.kindShape');
  if (message.includes('loyalty_rewards_points_cost_check'))
    return t('rewards.errors.pointsCost');
  if (message.includes('row-level security') || message.includes('42501'))
    return t('rewards.errors.permission');
  console.error('Saving a loyalty reward failed', message);
  return t('rewards.errors.saveFailed');
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}
