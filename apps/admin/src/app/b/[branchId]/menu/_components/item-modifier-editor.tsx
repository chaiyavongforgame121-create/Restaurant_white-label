'use client';

import * as React from 'react';
import { Check, Minus, Plus, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button, cn } from '@favornoms/ui';

// Per-item modifier editor — manage this menu item's option groups (Size, Add-ons, …)
// and their options right inside the item editor. Groups created here are linked to this
// item via menu_item_modifiers; "Remove" unlinks and cleans up the group if no other item
// uses it. The standalone /menu/modifiers page still handles sharing a group across items.

interface MOption {
  id: string;
  name: string;
  price_delta: number | string;
  is_default: boolean;
  is_active: boolean;
  display_order: number;
}

interface MGroup {
  id: string;
  name: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_select: number;
  max_select: number;
  display_order: number;
  options: MOption[];
}

const GROUP_SELECT = `display_order, modifier_groups!inner(
  id, name, selection_type, is_required, min_select, max_select, display_order,
  modifier_options(id, name, price_delta, is_default, is_active, display_order)
)`;

// Imperative handle the parent item form uses to validate + flush draft option
// groups once a brand-new menu item has been inserted and finally has an id to
// link against.
export interface ItemModifierEditorHandle {
  /** Returns a user-facing message if the draft is half-filled, else null. */
  validateDraft: () => string | null;
  persistDraft: (newItemId: string) => Promise<{ error?: string }>;
}

// Drop the noise a draft can accumulate before it reaches the DB: trim names,
// remove blank-named options, and drop groups that are completely empty (a user
// clicked "Add group" then moved on). Anything that survives is real data.
function cleanDraftGroups(groups: MGroup[]): MGroup[] {
  return groups
    .map((g) => ({
      ...g,
      name: g.name.trim(),
      options: g.options
        .filter((o) => String(o.name).trim())
        .map((o) => ({ ...o, name: String(o.name).trim() })),
    }))
    .filter((g) => g.name || g.options.length > 0);
}

// `itemId` is null while creating a new item. In that "draft" mode every edit
// stays in local React state (temp ids) and nothing touches the DB until the
// parent saves the item and calls persistDraft(); for an existing item we keep
// the original write-through behaviour so each tweak persists immediately.
export const ItemModifierEditor = React.forwardRef<
  ItemModifierEditorHandle,
  { branchId: string; itemId: string | null }
>(function ItemModifierEditor({ branchId, itemId }, ref) {
  const isDraft = !itemId;
  const [groups, setGroups] = React.useState<MGroup[]>([]);
  const [loading, setLoading] = React.useState(!isDraft);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const tmpCounter = React.useRef(0);
  const newTmpId = () => `tmp_${tmpCounter.current++}`;

  const fetchGroups = React.useCallback(async () => {
    if (!itemId) return;
    const supabase = getBrowserClient();
    const { data } = await supabase
      .from('menu_item_modifiers')
      .select(GROUP_SELECT)
      .eq('menu_item_id', itemId)
      .order('display_order');
    const mapped: MGroup[] = (data ?? [])
      .map((row) => {
        const g = Array.isArray(row.modifier_groups) ? row.modifier_groups[0] : row.modifier_groups;
        if (!g) return null;
        return {
          id: g.id,
          name: g.name,
          selection_type: (g.selection_type as 'single' | 'multiple') ?? 'single',
          is_required: !!g.is_required,
          min_select: g.min_select ?? 0,
          max_select: g.max_select ?? 1,
          display_order: row.display_order ?? g.display_order ?? 0,
          options: (g.modifier_options ?? [])
            .slice()
            .sort((a, b) => (a.display_order ?? 0) - (b.display_order ?? 0)) as MOption[],
        } as MGroup;
      })
      .filter((x): x is MGroup => x !== null)
      .sort((a, b) => a.display_order - b.display_order);
    setGroups(mapped);
    setLoading(false);
  }, [itemId]);

  React.useEffect(() => {
    if (itemId) void fetchGroups();
  }, [itemId, fetchGroups]);

  // Block save while a group is half-built so we never ship a blank-named group
  // or an optionless one — a Required group with no options dead-ends the cart,
  // and unnamed controls are broken/inaccessible on the customer menu.
  const validateDraft = React.useCallback((): string | null => {
    for (const g of groups) {
      const gname = g.name.trim();
      const named = g.options.filter((o) => String(o.name).trim());
      const blanks = g.options.filter((o) => !String(o.name).trim());
      // A completely empty group (no name, no options) is silently dropped later.
      if (!gname && g.options.length === 0) continue;
      if (!gname) return 'Give every option group a name (e.g. Size) before saving.';
      if (named.length === 0) return `Add at least one option to the "${gname}" group, or remove the group.`;
      if (blanks.length > 0) return `Name every option in "${gname}", or remove the blank ones.`;
    }
    return null;
  }, [groups]);

  // Flush all locally-built groups/options to the DB for a freshly-created item.
  // Order per group: insert the group, then its options, then the item link LAST,
  // so a mid-way failure leaves an unlinked (invisible, harmless) group rather
  // than a linked group with no options that would dead-end the customer cart.
  const persistDraft = React.useCallback(
    async (newItemId: string): Promise<{ error?: string }> => {
      const supabase = getBrowserClient();
      const clean = cleanDraftGroups(groups);
      for (const [gi, g] of clean.entries()) {
        const { data: gRow, error: ge } = await supabase
          .from('modifier_groups')
          .insert({
            branch_id: branchId,
            name: g.name,
            selection_type: g.selection_type,
            is_required: g.is_required,
            min_select: g.min_select,
            max_select: g.max_select,
            display_order: gi,
          })
          .select('id')
          .single();
        if (ge || !gRow) return { error: ge?.message ?? 'Could not save option group' };
        if (g.options.length) {
          const { error: oe } = await supabase.from('modifier_options').insert(
            g.options.map((o, oi) => ({
              group_id: gRow.id,
              name: o.name,
              price_delta: Number(o.price_delta) || 0,
              is_default: o.is_default,
              is_active: o.is_active,
              display_order: oi,
            })),
          );
          if (oe) return { error: oe.message };
        }
        const { error: le } = await supabase
          .from('menu_item_modifiers')
          .insert({ menu_item_id: newItemId, modifier_group_id: gRow.id, display_order: gi });
        if (le) return { error: le.message };
      }
      return {};
    },
    [groups, branchId],
  );

  React.useImperativeHandle(ref, () => ({ validateDraft, persistDraft }), [validateDraft, persistDraft]);

  const addGroup = async () => {
    if (isDraft) {
      setGroups((cur) => [
        ...cur,
        {
          id: newTmpId(),
          name: '',
          selection_type: 'single',
          is_required: false,
          min_select: 0,
          max_select: 1,
          display_order: cur.length,
          options: [],
        },
      ]);
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = getBrowserClient();
    const { data: g, error: e } = await supabase
      .from('modifier_groups')
      .insert({
        branch_id: branchId,
        name: '',
        selection_type: 'single',
        is_required: false,
        min_select: 0,
        max_select: 1,
        display_order: groups.length,
      })
      .select('id')
      .single();
    if (e || !g) {
      setBusy(false);
      setError(e?.message ?? 'Could not create group');
      return;
    }
    const { error: le } = await supabase
      .from('menu_item_modifiers')
      .insert({ menu_item_id: itemId, modifier_group_id: g.id, display_order: groups.length });
    setBusy(false);
    if (le) {
      setError(le.message);
      return;
    }
    await fetchGroups();
  };

  const updateGroup = async (id: string, patch: Partial<MGroup>) => {
    setGroups((cur) => cur.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    if (isDraft) return;
    const supabase = getBrowserClient();
    const { error: e } = await supabase.from('modifier_groups').update(patch).eq('id', id);
    if (e) setError(e.message);
  };

  const removeGroup = async (id: string) => {
    if (!confirm('Remove this option group from this item?')) return;
    if (isDraft) {
      setGroups((cur) => cur.filter((g) => g.id !== id));
      return;
    }
    const supabase = getBrowserClient();
    await supabase
      .from('menu_item_modifiers')
      .delete()
      .eq('menu_item_id', itemId)
      .eq('modifier_group_id', id);
    const { count } = await supabase
      .from('menu_item_modifiers')
      .select('*', { count: 'exact', head: true })
      .eq('modifier_group_id', id);
    if ((count ?? 0) === 0) await supabase.from('modifier_groups').delete().eq('id', id);
    await fetchGroups();
  };

  const addOption = async (groupId: string) => {
    if (isDraft) {
      setGroups((cur) =>
        cur.map((g) =>
          g.id === groupId
            ? {
                ...g,
                options: [
                  ...g.options,
                  {
                    id: newTmpId(),
                    name: '',
                    price_delta: 0,
                    is_default: false,
                    is_active: true,
                    display_order: g.options.length,
                  },
                ],
              }
            : g,
        ),
      );
      return;
    }
    const supabase = getBrowserClient();
    const grp = groups.find((g) => g.id === groupId);
    const { error: e } = await supabase.from('modifier_options').insert({
      group_id: groupId,
      name: '',
      price_delta: 0,
      is_default: false,
      is_active: true,
      display_order: grp?.options.length ?? 0,
    });
    if (e) {
      setError(e.message);
      return;
    }
    await fetchGroups();
  };

  const updateOption = async (groupId: string, optId: string, patch: Partial<MOption>) => {
    setGroups((cur) =>
      cur.map((g) =>
        g.id === groupId
          ? { ...g, options: g.options.map((o) => (o.id === optId ? { ...o, ...patch } : o)) }
          : g,
      ),
    );
    if (isDraft) return;
    const supabase = getBrowserClient();
    const { error: e } = await supabase.from('modifier_options').update(patch).eq('id', optId);
    if (e) setError(e.message);
  };

  // "Default" behaves like a radio in single-select groups: turning one on clears the others.
  const toggleDefault = async (group: MGroup, optId: string) => {
    const opt = group.options.find((o) => o.id === optId);
    const next = !opt?.is_default;
    if (group.selection_type === 'single' && next) {
      setGroups((cur) =>
        cur.map((g) =>
          g.id === group.id
            ? { ...g, options: g.options.map((o) => ({ ...o, is_default: o.id === optId })) }
            : g,
        ),
      );
      if (isDraft) return;
      const supabase = getBrowserClient();
      await supabase.from('modifier_options').update({ is_default: true }).eq('id', optId);
      const others = group.options.filter((o) => o.id !== optId && o.is_default).map((o) => o.id);
      if (others.length) await supabase.from('modifier_options').update({ is_default: false }).in('id', others);
    } else {
      void updateOption(group.id, optId, { is_default: next });
    }
  };

  const removeOption = async (groupId: string, optId: string) => {
    if (isDraft) {
      setGroups((cur) =>
        cur.map((g) =>
          g.id === groupId ? { ...g, options: g.options.filter((o) => o.id !== optId) } : g,
        ),
      );
      return;
    }
    const supabase = getBrowserClient();
    await supabase.from('modifier_options').delete().eq('id', optId);
    await fetchGroups();
  };

  // Stop Enter inside these inputs from submitting the parent item form.
  const noEnterSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <div className="space-y-3" onKeyDown={noEnterSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">Options</p>
          <p className="text-xs text-muted-foreground">Size, add-ons, prep choices customers pick</p>
        </div>
        <Button type="button" variant="soft" size="sm" onClick={addGroup} loading={busy} leftIcon={<Plus className="h-4 w-4" />}>
          Add group
        </Button>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">Loading options…</p>
      ) : groups.length === 0 ? (
        <button
          type="button"
          onClick={addGroup}
          className="focus-ring flex w-full flex-col items-center gap-1 rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/5"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
            <Plus className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold text-foreground">Add an option group</span>
          <span className="text-xs text-muted-foreground">
            e.g. <strong>Size</strong> (pick 1) or <strong>Add-ons</strong> (pick many)
          </span>
        </button>
      ) : (
        <div className="space-y-3">
          {groups.map((group) => (
            <ModifierGroupCard
              key={group.id}
              group={group}
              onGroupChange={(patch) => updateGroup(group.id, patch)}
              onRemoveGroup={() => removeGroup(group.id)}
              onOptionChange={(optId, patch) => updateOption(group.id, optId, patch)}
              onToggleDefault={(optId) => toggleDefault(group, optId)}
              onRemoveOption={(optId) => removeOption(group.id, optId)}
              onAddOption={() => addOption(group.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function ModifierGroupCard({
  group: g,
  onGroupChange,
  onRemoveGroup,
  onOptionChange,
  onToggleDefault,
  onRemoveOption,
  onAddOption,
}: {
  group: MGroup;
  onGroupChange: (patch: Partial<MGroup>) => void;
  onRemoveGroup: () => void;
  onOptionChange: (optId: string, patch: Partial<MOption>) => void;
  onToggleDefault: (optId: string) => void;
  onRemoveOption: (optId: string) => void;
  onAddOption: () => void;
}) {
  const isMulti = g.selection_type === 'multiple';
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      {/* Header: group name + remove */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2.5">
        <input
          value={g.name}
          onChange={(e) => onGroupChange({ name: e.target.value })}
          placeholder="Group name (e.g. Size)"
          className="focus-ring min-w-0 flex-1 rounded-lg bg-transparent px-1.5 py-1 font-display text-base font-bold placeholder:font-sans placeholder:font-normal placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={onRemoveGroup}
          title="Remove group"
          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" /> Remove
        </button>
      </div>

      {/* Rules: selection type + required + max */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="inline-flex rounded-full bg-muted p-0.5">
          <SegBtn active={!isMulti} onClick={() => onGroupChange({ selection_type: 'single', max_select: 1, min_select: g.is_required ? 1 : 0 })}>
            Pick 1
          </SegBtn>
          <SegBtn active={isMulti} onClick={() => onGroupChange({ selection_type: 'multiple', max_select: Math.max(2, g.max_select) })}>
            Pick many
          </SegBtn>
        </div>

        {isMulti && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-1 text-xs">
            <span className="text-muted-foreground">up to</span>
            <Stepper
              value={g.max_select}
              min={1}
              onChange={(v) => onGroupChange({ max_select: v })}
            />
          </div>
        )}

        <TogglePill on={g.is_required} onClick={() => onGroupChange({ is_required: !g.is_required, min_select: !g.is_required ? Math.max(1, g.min_select) : 0 })}>
          {g.is_required ? 'Required' : 'Optional'}
        </TogglePill>
      </div>

      {/* Options */}
      <div className="space-y-2 px-3 pb-3">
        {g.options.map((opt) => (
          <div
            key={opt.id}
            className={cn(
              'rounded-xl border bg-background p-2.5 transition-opacity',
              opt.is_active ? 'border-border' : 'border-dashed border-border opacity-60',
            )}
          >
            <div className="flex items-center gap-2">
              <input
                value={opt.name}
                onChange={(e) => onOptionChange(opt.id, { name: e.target.value })}
                placeholder="Option name (e.g. Large)"
                className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-medium"
              />
              <button
                type="button"
                onClick={() => onRemoveOption(opt.id)}
                title="Delete option"
                className="focus-ring grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-danger/10 hover:text-danger"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 pl-2">
                <span className="text-xs font-semibold text-muted-foreground">+$</span>
                <input
                  type="number"
                  step="0.01"
                  value={String(opt.price_delta)}
                  onChange={(e) => onOptionChange(opt.id, { price_delta: e.target.value as never })}
                  className="focus-ring w-16 rounded-lg bg-transparent px-1.5 py-1 text-sm tabular-nums"
                />
              </div>
              <TogglePill on={opt.is_default} onClick={() => onToggleDefault(opt.id)}>
                Default
              </TogglePill>
              <TogglePill on={opt.is_active} onClick={() => onOptionChange(opt.id, { is_active: !opt.is_active })}>
                {opt.is_active ? 'Active' : 'Hidden'}
              </TogglePill>
            </div>
          </div>
        ))}
        <button
          type="button"
          onClick={onAddOption}
          className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/5"
        >
          <Plus className="h-3.5 w-3.5" /> Add option
        </button>
      </div>
    </div>
  );
}

function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'focus-ring rounded-full px-3 py-1 text-xs font-semibold transition-colors',
        active ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function TogglePill({ on, onClick, children }: { on: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={on}
      className={cn(
        'focus-ring inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors',
        on ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground hover:bg-muted/70',
      )}
    >
      {on && <Check className="h-3 w-3" />}
      {children}
    </button>
  );
}

function Stepper({ value, min, onChange }: { value: number; min: number; onChange: (v: number) => void }) {
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="focus-ring grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-muted/70"
        aria-label="Decrease"
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="w-4 text-center font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="focus-ring grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-muted/70"
        aria-label="Increase"
      >
        <Plus className="h-3 w-3" />
      </button>
    </span>
  );
}
