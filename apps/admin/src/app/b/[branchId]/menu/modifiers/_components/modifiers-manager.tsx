'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { ChevronDown, ChevronUp, Link2, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

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

export function ModifiersManager({ branchId, initialGroups, menuItems }: Props) {
  const router = useRouter();
  const [groups, setGroups] = React.useState(initialGroups);
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

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
    const name = window.prompt('Modifier group name (e.g. "Size", "Add-ons")');
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
      setError(insErr.message);
      return;
    }
    await refetch();
  };

  const updateGroup = async (id: string, patch: Partial<Group>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('modifier_groups').update(patch).eq('id', id);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    setGroups((curr) => curr.map((g) => (g.id === id ? { ...g, ...patch } : g)));
  };

  const deleteGroup = async (id: string) => {
    if (!window.confirm('Delete this modifier group and all its options? This affects every menu item linked to it.')) return;
    const supabase = getBrowserClient();
    const { error: delErr } = await supabase.from('modifier_groups').delete().eq('id', id);
    if (delErr) {
      setError(delErr.message);
      return;
    }
    setGroups((curr) => curr.filter((g) => g.id !== id));
  };

  const addOption = async (groupId: string) => {
    const name = window.prompt('Option name (e.g. "Large", "Extra cheese")');
    if (!name) return;
    const priceStr = window.prompt('Price delta (USD, can be 0 or negative)', '0');
    if (priceStr === null) return;
    const price = Number(priceStr);
    if (!Number.isFinite(price)) {
      setError('Invalid price.');
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
      setError(insErr.message);
      return;
    }
    await refetch();
  };

  const updateOption = async (optionId: string, patch: Partial<Option>) => {
    const supabase = getBrowserClient();
    const { error: upErr } = await supabase.from('modifier_options').update(patch).eq('id', optionId);
    if (upErr) {
      setError(upErr.message);
      return;
    }
    await refetch();
  };

  const deleteOption = async (optionId: string) => {
    if (!window.confirm('Delete this option?')) return;
    const supabase = getBrowserClient();
    const { error: delErr } = await supabase.from('modifier_options').delete().eq('id', optionId);
    if (delErr) {
      setError(delErr.message);
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
          <h1 className="font-display text-3xl font-bold">Modifier groups</h1>
          <p className="mt-1 text-muted-foreground">
            Size, add-ons, prep options — anything customers customize on an item.
          </p>
        </div>
        <Button variant="gradient" onClick={createGroup} leftIcon={<Plus className="h-4 w-4" />}>
          New group
        </Button>
      </header>

      {error && (
        <div className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {groups.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          No modifier groups yet. Create one (e.g. &ldquo;Size&rdquo; with Small / Medium / Large) and link it to menu items.
        </Card>
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
                          {g.is_required ? 'Required · ' : 'Optional · '}
                          {g.selection_type === 'single' ? 'pick 1' : `pick up to ${g.max_select}`}
                          {' · '}
                          {g.modifier_options.length} option{g.modifier_options.length === 1 ? '' : 's'}
                          {' · '}
                          linked to {linked.length} item{linked.length === 1 ? '' : 's'}
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
                        Delete
                      </Button>
                    </div>
                  </div>

                  {expandedId === g.id && (
                    <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                      <GroupSettings group={g} onChange={(patch) => updateGroup(g.id, patch)} />

                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          Options
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
                                    /> Default
                                  </label>
                                  <label className="flex items-center gap-1 text-xs">
                                    <input
                                      type="checkbox"
                                      checked={opt.is_active}
                                      onChange={(e) => updateOption(opt.id, { is_active: e.target.checked })}
                                    /> Active
                                  </label>
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => deleteOption(opt.id)}
                                    leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                                  >
                                    Remove
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
                          Add option
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
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Name</span>
        <input
          value={group.name}
          onChange={(e) => onChange({ name: e.target.value })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Type</span>
        <select
          value={group.selection_type}
          onChange={(e) => onChange({ selection_type: e.target.value as 'single' | 'multiple' })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        >
          <option value="single">Single (radio)</option>
          <option value="multiple">Multiple (checkbox)</option>
        </select>
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Min</span>
        <input
          type="number"
          min={0}
          value={group.min_select}
          onChange={(e) => onChange({ min_select: Number(e.target.value) || 0 })}
          className="focus-ring w-full rounded-lg border border-border bg-background px-2 py-1.5 text-sm"
        />
      </label>
      <label className="block">
        <span className="mb-1 block text-xs font-medium">Max</span>
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
        Required (customer must pick at least min)
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
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(new Set(linked.map((m) => m.id)));

  React.useEffect(() => {
    setSelected(new Set(linked.map((m) => m.id)));
  }, [linked]);

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          Linked to{' '}
          {linked.length > 0 ? (
            linked.slice(0, 3).map((m) => m.name).join(', ') +
            (linked.length > 3 ? ` + ${linked.length - 3} more` : '')
          ) : (
            <span className="text-muted-foreground">no items yet</span>
          )}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen((o) => !o)}
          leftIcon={<Link2 className="h-3.5 w-3.5" />}
        >
          {open ? 'Cancel' : 'Edit links'}
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
                {selected.has(m.id) && <Badge variant="success" className="ml-auto">linked</Badge>}
              </label>
            ))}
            {menuItems.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">No active menu items in this branch.</p>
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
            Save links
          </Button>
        </div>
      )}
    </div>
  );
}
