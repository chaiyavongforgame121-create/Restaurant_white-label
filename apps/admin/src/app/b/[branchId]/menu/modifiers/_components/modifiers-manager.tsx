'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Link2, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, useConfirm, usePrompt } from '@favornoms/ui';

interface Option {
  id: string;
  name: string;
  price_delta: number | string;
  is_default: boolean;
  is_active: boolean;
  display_order: number;
}

interface Group {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  is_required: boolean;
  selection_type: 'single' | 'multiple';
  display_order: number;
  modifier_options: Option[];
}

interface MenuItem {
  id: string;
  name: string;
  menu_item_modifiers: Array<{ modifier_group_id: string }>;
}

interface Props {
  branchId: string;
  initialGroups: Group[];
  menuItems: MenuItem[];
}

type DbErrorKey = 'permissionDenied' | 'network' | 'duplicate' | 'inUse' | 'invalidValue' | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes get a translated sentence. */
function dbErrorKey(err: { code?: string; message?: string }): DbErrorKey {
  const message = err.message ?? '';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'network';
  if (err.code === '23505') return 'duplicate';
  if (err.code === '23503') return 'inUse';
  if (err.code && /^(22|23)/.test(err.code)) return 'invalidValue';
  return 'generic';
}

export function ModifiersManager({ branchId, initialGroups, menuItems }: Props) {
  const t = useTranslations('menuExtras');
  const router = useRouter();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [groups, setGroups] = React.useState(initialGroups);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const dbError = (context: string, err: { code?: string; message?: string }) => {
    console.error(`[modifiers] ${context}`, err);
    return t(`errors.${dbErrorKey(err)}`);
  };

  const refetch = async () => {
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('modifier_groups')
      .select(
        `id, name, min_select, max_select, is_required, selection_type, display_order,
         modifier_options(id, name, price_delta, is_default, is_active, display_order)`,
      )
      .eq('branch_id', branchId)
      .order('display_order');
    setGroups((data ?? []) as Group[]);
  };

  const createGroup = async () => {
    const name = await prompt({
      title: t('modifiers.createPrompt.title'),
      body: t('modifiers.createPrompt.body'),
      placeholder: t('modifiers.createPrompt.placeholder'),
      confirmLabel: t('modifiers.createPrompt.confirm'),
      required: true,
    });
    if (!name) return;
    const supabase = getBrowserClient();
    const { error: insErr } = await supabase.from('modifier_groups').insert({
      branch_id: branchId,
      name,
      min_select: 0,
      max_select: 1,
      is_required: false,
      selection_type: 'single',
      display_order: groups.length,
    });
    if (insErr) {
      setError(dbError('create group', insErr));
      return;
    }
    await refetch();
  };

  const updateGroup = async (id: string, patch: Partial<Group>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('modifier_groups').update(patch).eq('id', id);
    if (upErr) {
      setError(dbError('update group', upErr));
      return;
    }
    setGroups((curr) => curr.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };

  const deleteGroup = async (id: string) => {
    if (
      !(await confirm({
        title: t('modifiers.deleteGroupConfirm.title'),
        body: t('modifiers.deleteGroupConfirm.body'),
        confirmLabel: t('modifiers.deleteGroupConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    const { error: delErr } = await supabase.from('modifier_groups').delete().eq('id', id);
    if (delErr) {
      setError(dbError('delete group', delErr));
      return;
    }
    setGroups((curr) => curr.filter((g) => g.id !== id));
  };

  const addOption = async (groupId: string) => {
    const name = await prompt({
      title: t('modifiers.optionPrompt.title'),
      body: t('modifiers.optionPrompt.body'),
      placeholder: t('modifiers.optionPrompt.placeholder'),
      confirmLabel: t('modifiers.optionPrompt.confirm'),
      required: true,
    });
    if (!name) return;
    const priceStr = await prompt({
      title: t('modifiers.pricePrompt.title'),
      body: t('modifiers.pricePrompt.body'),
      defaultValue: '0',
      confirmLabel: t('modifiers.pricePrompt.confirm'),
    });
    if (priceStr === null) return;
    const price = Number(priceStr);
    if (!Number.isFinite(price)) {
      setError(t('errors.invalidPrice'));
      return;
    }
    const supabase = getBrowserClient();
    const grp = groups.find((g) => g.id === groupId);
    const { error: insErr } = await supabase.from('modifier_options').insert({
      group_id: groupId,
      name,
      price_delta: price,
      is_default: false,
      is_active: true,
      display_order: grp?.modifier_options.length ?? 0,
    });
    if (insErr) {
      setError(dbError('add option', insErr));
      return;
    }
    await refetch();
  };

  const updateOption = async (optionId: string, patch: Partial<Option>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('modifier_options').update(patch).eq('id', optionId);
    if (upErr) {
      setError(dbError('update option', upErr));
      return;
    }
    await refetch();
  };

  const deleteOption = async (optionId: string) => {
    if (
      !(await confirm({
        title: t('modifiers.deleteOptionConfirm.title'),
        body: t('modifiers.deleteOptionConfirm.body'),
        confirmLabel: t('modifiers.deleteOptionConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    const supabase = getBrowserClient();
    const { error: delErr } = await supabase.from('modifier_options').delete().eq('id', optionId);
    if (delErr) {
      setError(dbError('delete option', delErr));
      return;
    }
    await refetch();
  };

  const linkToItems = async (groupId: string, itemIds: Set<string>) => {
    const supabase = getBrowserClient();
    // Remove existing links not in the new set
    const currentLinks = menuItems.filter((m) =>
      m.menu_item_modifiers.some((l) => l.modifier_group_id === groupId),
    );
    const toRemove = currentLinks.filter((m) => !itemIds.has(m.id)).map((m) => m.id);
    const toAdd = Array.from(itemIds).filter(
      (id) => !currentLinks.some((m) => m.id === id),
    );

    if (toRemove.length > 0) {
      await supabase
        .from('menu_item_modifiers')
        .delete()
        .eq('modifier_group_id', groupId)
        .in('menu_item_id', toRemove);
    }
    if (toAdd.length > 0) {
      await supabase.from('menu_item_modifiers').insert(
        toAdd.map((mid, idx) => ({
          menu_item_id: mid,
          modifier_group_id: groupId,
          display_order: idx,
        })),
      );
    }
    router.refresh();
  };

  return (
    <div className="container max-w-5xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('modifiers.title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('modifiers.subtitle')}</p>
        </div>
        <Button variant="gradient" onClick={createGroup} leftIcon={<Plus className="h-4 w-4" />}>
          {t('modifiers.newGroup')}
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {groups.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">{t('modifiers.empty')}</Card>
      ) : (
        <ul className="space-y-3 px-2 lg:px-0">
          {groups.map((g) => {
            const linked = menuItems.filter((m) =>
              m.menu_item_modifiers.some((l) => l.modifier_group_id === g.id),
            );
            return (
              <li key={g.id}>
                <Card className="p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => setExpandedId((c) => (c === g.id ? null : g.id))}
                      className="focus-ring flex flex-1 items-center gap-3 text-left"
                    >
                      {expandedId === g.id ? (
                        <ChevronUp className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <ChevronDown className="h-4 w-4 text-muted-foreground" />
                      )}
                      <div>
                        <p className="font-display text-lg font-semibold">{g.name}</p>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          {g.is_required ? t('modifiers.required') : t('modifiers.optional')}
                          {' · '}
                          {g.selection_type === 'single'
                            ? t('modifiers.pickOne')
                            : t('modifiers.pickUpTo', { max: g.max_select })}
                          {' · '}
                          {t('modifiers.optionCount', { count: g.modifier_options.length })}
                          {' · '}
                          {t('modifiers.linkedCount', { count: linked.length })}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteGroup(g.id)}
                        leftIcon={<Trash2 className="h-4 w-4" />}
                      >
                        {t('modifiers.delete')}
                      </Button>
                    </div>
                  </div>

                  {expandedId === g.id && (
                    <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                      <GroupSettings group={g} onChange={(patch) => updateGroup(g.id, patch)} />

                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t('modifiers.options')}
                        </p>
                        <ul className="space-y-2">
                          {g.modifier_options
                            .sort((a, b) => a.display_order - b.display_order)
                            .map((opt) => (
                              <li key={opt.id}>
                                <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-card p-3">
                                  <input
                                    type="text"
                                    value={opt.name}
                                    onChange={(e) => updateOption(opt.id, { name: e.target.value })}
                                    className="focus-ring flex-1 rounded-lg border border-border bg-background px-2 py-1 text-sm"
                                  />
                                  <input
                                    type="number"
                                    step="0.01"
                                    value={String(opt.price_delta)}
                                    onChange={(e) => updateOption(opt.id, { price_delta: e.target.value as never })}
                                    className="focus-ring w-24 rounded-lg border border-border bg-background px-2 py-1 text-sm tabular-nums"
                                  />
                                  <span className="text-xs text-muted-foreground">{formatCurrency(Number(opt.price_delta))}</span>
                                  <label className="flex items-center gap-1 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={opt.is_default}
                                      onChange={(e) => updateOption(opt.id, { is_default: e.target.checked })}
                                    /> {t('modifiers.default')}
                                  </label>
                                  <label className="flex items-center gap-1 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={opt.is_active}
                                      onChange={(e) => updateOption(opt.id, { is_active: e.target.checked })}
                                    /> {t('modifiers.active')}
                                  </label>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteOption(opt.id)}
                                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                                  >
                                    {t('modifiers.remove')}
                                  </Button>
                                </div>
                              </li>
                            ))}
                        </ul>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => addOption(g.id)}
                          leftIcon={<Plus className="h-4 w-4" />}
                        >
                          {t('modifiers.addOption')}
                        </Button>
                      </div>

                      <LinkPicker
                        groupId={g.id}
                        menuItems={menuItems}
                        linked={linked}
                        onSave={(itemIds) => linkToItems(g.id, itemIds)}
                      />
                    </div>
                  )}
                </Card>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function GroupSettings({
  group,
  onChange,
}: {
  group: Group;
  onChange: (patch: Partial<Group>) => void;
}) {
  const t = useTranslations('menuExtras.modifiers.settings');
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium">{t('name')}</span>
        <input
          value={group.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">{t('type')}</span>
        <select
          value={group.selection_type}
          onChange={(e) => onChange({ selection_type: e.target.value as 'single' | 'multiple' })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="single">{t('single')}</option>
          <option value="multiple">{t('multiple')}</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">{t('min')}</span>
        <input
          type="number"
          min={0}
          value={group.min_select}
          onChange={(e) => onChange({ min_select: Number(e.target.value) || 0 })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">{t('max')}</span>
        <input
          type="number"
          min={1}
          value={group.max_select}
          onChange={(e) => onChange({ max_select: Math.max(1, Number(e.target.value)) })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <label className="col-span-2 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={group.is_required}
          onChange={(e) => onChange({ is_required: e.target.checked })}
        />
        {t('required')}
      </label>
    </div>
  );
}

function LinkPicker({
  groupId,
  menuItems,
  linked,
  onSave,
}: {
  groupId: string;
  menuItems: MenuItem[];
  linked: MenuItem[];
  onSave: (itemIds: Set<string>) => void;
}) {
  const t = useTranslations('menuExtras.modifiers.links');
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(linked.map((m) => m.id)));

  React.useEffect(() => {
    setSelected(new Set(linked.map((m) => m.id)));
  }, [linked]);

  // Item names are the merchant's own words, so they go into the sentence untouched.
  const names = linked.slice(0, 3).map((m) => m.name).join(', ');

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {linked.length === 0
            ? t.rich('none', { muted: (chunks) => <span className="text-muted-foreground">{chunks}</span> })
            : linked.length > 3
              ? t('linkedToMore', { names, count: linked.length - 3 })
              : t('linkedTo', { names })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          leftIcon={<Link2 className="h-3.5 w-3.5" />}
        >
          {open ? t('cancel') : t('edit')}
        </Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-2">
            {menuItems.map((m) => (
              <label key={m.id} className="flex items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted">
                <input
                  type="checkbox"
                  checked={selected.has(m.id)}
                  onChange={(e) => {
                    setSelected((curr) => {
                      const next = new Set(curr);
                      if (e.target.checked) next.add(m.id);
                      else next.delete(m.id);
                      return next;
                    });
                  }}
                />
                {m.name}
                {selected.has(m.id) && <Badge variant="success" className="ml-auto">{t('linked')}</Badge>}
              </label>
            ))}
            {menuItems.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t('noItems')}</p>
            )}
          </div>
          <Button
            variant="gradient"
            size="sm"
            onClick={() => {
              onSave(selected);
              setOpen(false);
            }}
          >
            {t('save')}
          </Button>
        </div>
      )}
    </div>
  );
}
