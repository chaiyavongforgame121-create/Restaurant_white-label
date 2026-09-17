'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronUp, Minus, Plus, Trash2 } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { compareByPosition, type PositionedRow } from '@favornoms/database/queries';
import { Button, cn, IconButton, useConfirm } from '@favornoms/ui';
import { menuErrorKey } from './menu-errors';

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
  /** Breaks position ties the way the storefront does; absent on a draft option. */
  created_at?: string | null;
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
  id, name, selection_type, is_required, min_select, max_select, display_order, created_at,
  modifier_options(id, name, price_delta, is_default, is_active, display_order, created_at)
)`;

// Imperative handle the parent item form uses to validate + flush draft option
// groups once a brand-new menu item has been inserted and finally has an id to
// link against.
export interface ItemModifierEditorHandle {
  /** Returns a translated, user-facing message if the draft is half-filled, else null. */
  validateDraft: () => string | null;
  /** `error` is a translated, user-facing reason; the raw failure is logged. */
  persistDraft: (newItemId: string) => Promise<{ error?: string }>;
}

// ── Positions ──────────────────────────────────────────────────────────────────────────────
// The storefront and the counter list an item's option groups by menu_item_modifiers.display_order
// and a group's options by modifier_options.display_order. These helpers are shared with the
// branch's option groups page (modifiers/_components/modifiers-manager.tsx).

export interface Positioned {
  id: string;
  display_order: number;
}

/**
 * Where a new row goes: after the highest position in use (0 for an empty list). The list length
 * is not enough: after a deletion it can equal a surviving row's position.
 */
export function nextPosition(list: readonly { display_order: number | null }[]): number {
  return list.reduce((next, row) => Math.max(next, (row.display_order ?? 0) + 1), 0);
}

/**
 * `list` with row `id` swapped with its neighbour (`dir` -1 = up, 1 = down) and every row
 * renumbered 0..n-1, or null when the row is already at that end.
 */
export function moveEntry<T extends Positioned>(list: readonly T[], id: string, dir: -1 | 1): T[] | null {
  const from = list.findIndex((row) => row.id === id);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= list.length) return null;
  const next = list.slice();
  [next[from], next[to]] = [next[to]!, next[from]!];
  return next.map((row, i) => (row.display_order === i ? row : { ...row, display_order: i }));
}

/** `current` put back in the order and positions of `snapshot`, keeping edits made in the meantime. */
export function restoreOrder<T extends Positioned>(current: readonly T[], snapshot: readonly T[]): T[] {
  const before = new Map(snapshot.map((row, index) => [row.id, { index, position: row.display_order }]));
  const rank = (row: T) => before.get(row.id)?.index ?? snapshot.length;
  return current
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((row) => {
      const was = before.get(row.id);
      return was && was.position !== row.display_order ? { ...row, display_order: was.position } : row;
    });
}

/**
 * React re-inserts a moved row in the DOM, which drops keyboard focus. Put it back on the arrow
 * that was pressed, or on its twin once that arrow is disabled at the end of the list.
 */
function keepFocusThroughMove(button: HTMLButtonElement) {
  if (document.activeElement !== button) return;
  const pair = button.parentElement;
  requestAnimationFrame(() => {
    if (document.activeElement === button || !button.isConnected) return;
    const target = button.disabled ? pair?.querySelector<HTMLButtonElement>('button:not(:disabled)') : button;
    target?.focus();
  });
}

/** Move up / Move down arrows for one row. Labels are translated by the caller and name the row. */
export function MoveButtons({
  upLabel,
  downLabel,
  canMoveUp,
  canMoveDown,
  onMove,
  className,
}: {
  upLabel: string;
  downLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  className?: string;
}) {
  const arrow = (dir: -1 | 1) => {
    const label = dir < 0 ? upLabel : downLabel;
    return (
      <IconButton
        type="button"
        size="sm"
        label={label}
        title={label}
        disabled={dir < 0 ? !canMoveUp : !canMoveDown}
        onClick={(e) => {
          keepFocusThroughMove(e.currentTarget);
          onMove(dir);
        }}
        className={cn(
          'text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:opacity-30',
          className,
        )}
      >
        {dir < 0 ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
      </IconButton>
    );
  };
  return (
    <div className="flex shrink-0 items-center">
      {arrow(-1)}
      {arrow(1)}
    </div>
  );
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
  const t = useTranslations('menu');
  const isDraft = !itemId;
  const [groups, setGroups] = React.useState<MGroup[]>([]);
  const [loading, setLoading] = React.useState(!isDraft);
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const confirm = useConfirm();
  const tmpCounter = React.useRef(0);
  const newTmpId = () => `tmp_${tmpCounter.current++}`;

  /** Logs the raw failure; the merchant gets a translated message instead of database text. */
  const errorText = React.useCallback(
    (context: string, err: unknown) => {
      console.error(`[menu] ${context} failed`, err);
      return t(`errors.${menuErrorKey(err)}`);
    },
    [t],
  );

  // A move swaps two neighbours on screen at once, then saves the whole list in its new order with
  // one call that renumbers every row 0..n-1 in a single statement (rows deleted meanwhile are
  // skipped). One move saves at a time: clicks while it is saving are ignored.
  const movingRef = React.useRef(false);
  // Reads and moves overlap: a read sent before a move was stored can still hold the old order, and
  // applying it would put the rows back although the move saved. So only the latest read is applied,
  // and only if no move was saving at any point while it was out; otherwise the list is read again
  // once the move has settled.
  const readSeq = React.useRef(0);
  const movesSettled = React.useRef(0);
  const readAfterMove = React.useRef(false);
  // Read through a ref so a new translator never re-runs the item's first read.
  const errorTextRef = React.useRef(errorText);
  React.useEffect(() => {
    errorTextRef.current = errorText;
  }, [errorText]);

  const fetchGroups = React.useCallback(async () => {
    if (!itemId) return;
    const supabase = getBrowserClient();
    for (;;) {
      const read = ++readSeq.current;
      const settledBefore = movesSettled.current;
      const { data, error: readError } = await supabase
        .from('menu_item_modifiers')
        .select(GROUP_SELECT)
        .eq('menu_item_id', itemId)
        .order('display_order');
      // A later read answers instead.
      if (read !== readSeq.current) return;
      if (movingRef.current) {
        readAfterMove.current = true;
        return;
      }
      // A move was stored while this read was out, so its answer may predate the move.
      if (movesSettled.current !== settledBefore) continue;
      if (readError) {
        // Keep the list on screen rather than blank it.
        const message = errorTextRef.current('load option groups', readError);
        setError((current) => current ?? message);
        setLoading(false);
        return;
      }
      const entries: { group: MGroup; link: number; own: PositionedRow }[] = [];
      for (const row of data ?? []) {
        const g = Array.isArray(row.modifier_groups) ? row.modifier_groups[0] : row.modifier_groups;
        if (!g) continue;
        entries.push({
          group: {
            id: g.id,
            name: g.name,
            selection_type: (g.selection_type as 'single' | 'multiple') ?? 'single',
            is_required: !!g.is_required,
            min_select: g.min_select ?? 0,
            max_select: g.max_select ?? 1,
            display_order: row.display_order ?? g.display_order ?? 0,
            options: (g.modifier_options ?? []).slice().sort(compareByPosition) as MOption[],
          },
          link: row.display_order ?? 0,
          own: g,
        });
      }
      // The storefront's order: position on this item, then the group's own position, age and id.
      entries.sort((a, b) => a.link - b.link || compareByPosition(a.own, b.own));
      setGroups(entries.map((entry) => entry.group));
      setLoading(false);
      return;
    }
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
      if (!gname) return t('modifiers.validation.groupName');
      if (named.length === 0) return t('modifiers.validation.noOptions', { group: gname });
      if (blanks.length > 0) return t('modifiers.validation.blankOptions', { group: gname });
    }
    return null;
  }, [groups, t]);

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
        if (ge || !gRow) {
          return { error: ge ? errorText('save option group', ge) : t('modifiers.groupSaveFailed') };
        }
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
          if (oe) return { error: errorText('save options', oe) };
        }
        const { error: le } = await supabase
          .from('menu_item_modifiers')
          .insert({ menu_item_id: newItemId, modifier_group_id: gRow.id, display_order: gi });
        if (le) return { error: errorText('link option group', le) };
      }
      return {};
    },
    [groups, branchId, errorText, t],
  );

  React.useImperativeHandle(ref, () => ({ validateDraft, persistDraft }), [validateDraft, persistDraft]);

  // One add at a time, until the list is read back: a second click before that would give the new
  // row the same position as the first.
  const addingGroupRef = React.useRef(false);
  const addingOptionRef = React.useRef(new Set<string>());
  const [addingOptionTo, setAddingOptionTo] = React.useState<ReadonlySet<string>>(() => new Set());

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
          display_order: nextPosition(cur),
          options: [],
        },
      ]);
      return;
    }
    if (addingGroupRef.current) return;
    addingGroupRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const position = nextPosition(groups);
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
          display_order: position,
        })
        .select('id')
        .single();
      if (e || !g) {
        setError(e ? errorText('create option group', e) : t('modifiers.groupCreateFailed'));
        return;
      }
      const { error: le } = await supabase
        .from('menu_item_modifiers')
        .insert({ menu_item_id: itemId, modifier_group_id: g.id, display_order: position });
      if (le) {
        setError(errorText('link option group', le));
        return;
      }
      await fetchGroups();
    } finally {
      addingGroupRef.current = false;
      setBusy(false);
    }
  };

  const updateGroup = async (id: string, patch: Partial<MGroup>) => {
    setGroups((cur) => cur.map((g) => (g.id === id ? { ...g, ...patch } : g)));
    if (isDraft) return;
    const supabase = getBrowserClient();
    const { error: e } = await supabase.from('modifier_groups').update(patch).eq('id', id);
    if (e) setError(errorText('update option group', e));
  };

  const removeGroup = async (id: string) => {
    if (
      !(await confirm({
        title: t('modifiers.removeConfirm.title'),
        body: t('modifiers.removeConfirm.body'),
        confirmLabel: t('modifiers.removeConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
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
                    display_order: nextPosition(g.options),
                  },
                ],
              }
            : g,
        ),
      );
      return;
    }
    const adding = addingOptionRef.current;
    if (adding.has(groupId)) return;
    const markAdding = (on: boolean) => {
      if (on) adding.add(groupId);
      else adding.delete(groupId);
      setAddingOptionTo(new Set(adding));
    };
    markAdding(true);
    try {
      const supabase = getBrowserClient();
      const grp = groups.find((g) => g.id === groupId);
      const { error: e } = await supabase.from('modifier_options').insert({
        group_id: groupId,
        name: '',
        price_delta: 0,
        is_default: false,
        is_active: true,
        display_order: nextPosition(grp?.options ?? []),
      });
      if (e) {
        setError(errorText('add option', e));
        return;
      }
      await fetchGroups();
    } finally {
      markAdding(false);
    }
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
    if (e) setError(errorText('update option', e));
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

  // Saves a move already shown on screen. The call is one statement, so a failure stored nothing:
  // the previous order goes back on screen and the list is read again. A draft (item not saved yet)
  // never gets here; persistDraft numbers rows by their index, so the saved order is the one on screen.
  const saveMove = async (
    context: string,
    save: () => PromiseLike<{ error: unknown }>,
    restore: () => void,
  ) => {
    movingRef.current = true;
    setError(null);
    let failure: unknown = null;
    try {
      ({ error: failure } = await save());
    } catch (err) {
      failure = err ?? new Error(`${context} threw`);
    } finally {
      movingRef.current = false;
      movesSettled.current += 1;
    }
    if (failure) {
      restore();
      setError(errorText(context, failure));
    }
    // Show what is really stored after a failure, or when a read was held back while this saved.
    if (failure || readAfterMove.current) {
      readAfterMove.current = false;
      await fetchGroups();
    }
  };

  const moveGroup = (groupId: string, dir: -1 | 1) => {
    if (movingRef.current) return;
    const before = groups;
    const after = moveEntry(before, groupId, dir);
    if (!after) return;
    setGroups(after);
    if (!itemId) return;
    const menuItemId = itemId;
    void saveMove(
      'reorder option groups',
      () =>
        getBrowserClient().rpc('reorder_item_modifier_groups', {
          p_menu_item_id: menuItemId,
          p_group_ids: after.map((g) => g.id),
        }),
      () => setGroups((cur) => restoreOrder(cur, before)),
    );
  };

  const moveOption = (groupId: string, optId: string, dir: -1 | 1) => {
    if (movingRef.current) return;
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const before = group.options;
    const after = moveEntry(before, optId, dir);
    if (!after) return;
    const setOptions = (update: (options: MOption[]) => MOption[]) =>
      setGroups((cur) => cur.map((g) => (g.id === groupId ? { ...g, options: update(g.options) } : g)));
    setOptions(() => after);
    if (!itemId) return;
    void saveMove(
      'reorder options',
      () =>
        getBrowserClient().rpc('reorder_modifier_options', {
          p_group_id: groupId,
          p_option_ids: after.map((o) => o.id),
        }),
      () => setOptions((cur) => restoreOrder(cur, before)),
    );
  };

  // Stop Enter inside these inputs from submitting the parent item form.
  const noEnterSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <div className="space-y-3" onKeyDown={noEnterSubmit}>
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-semibold">{t('modifiers.title')}</p>
          <p className="text-xs text-muted-foreground">{t('modifiers.subtitle')}</p>
        </div>
        <Button type="button" variant="soft" size="sm" onClick={addGroup} loading={busy} leftIcon={<Plus className="h-4 w-4" />}>
          {t('modifiers.addGroup')}
        </Button>
      </div>

      {error && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</p>}

      {loading ? (
        <p className="text-xs text-muted-foreground">{t('modifiers.loading')}</p>
      ) : groups.length === 0 ? (
        <button
          type="button"
          onClick={addGroup}
          disabled={busy}
          aria-busy={busy || undefined}
          className="focus-ring flex w-full flex-col items-center gap-1 rounded-2xl border border-dashed border-border bg-muted/20 px-4 py-6 text-center transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-60"
        >
          <span className="grid h-9 w-9 place-items-center rounded-full bg-primary/10 text-primary">
            <Plus className="h-5 w-5" />
          </span>
          <span className="text-sm font-semibold text-foreground">{t('modifiers.emptyTitle')}</span>
          <span className="text-xs text-muted-foreground">
            {t.rich('modifiers.emptyExample', { strong: (chunks) => <strong>{chunks}</strong> })}
          </span>
        </button>
      ) : (
        <div className="space-y-3">
          {groups.map((group, index) => (
            <ModifierGroupCard
              key={group.id}
              group={group}
              canMoveUp={index > 0}
              canMoveDown={index < groups.length - 1}
              onMove={(dir) => moveGroup(group.id, dir)}
              onGroupChange={(patch) => updateGroup(group.id, patch)}
              onRemoveGroup={() => removeGroup(group.id)}
              onOptionChange={(optId, patch) => updateOption(group.id, optId, patch)}
              onMoveOption={(optId, dir) => moveOption(group.id, optId, dir)}
              onToggleDefault={(optId) => toggleDefault(group, optId)}
              onRemoveOption={(optId) => removeOption(group.id, optId)}
              addingOption={addingOptionTo.has(group.id)}
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
  canMoveUp,
  canMoveDown,
  onMove,
  onGroupChange,
  onRemoveGroup,
  onOptionChange,
  onMoveOption,
  onToggleDefault,
  onRemoveOption,
  addingOption,
  onAddOption,
}: {
  group: MGroup;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  onGroupChange: (patch: Partial<MGroup>) => void;
  onRemoveGroup: () => void;
  onOptionChange: (optId: string, patch: Partial<MOption>) => void;
  onMoveOption: (optId: string, dir: -1 | 1) => void;
  onToggleDefault: (optId: string) => void;
  onRemoveOption: (optId: string) => void;
  /** An option is being added to this group; the button stays disabled until the list is read back. */
  addingOption: boolean;
  onAddOption: () => void;
}) {
  const t = useTranslations('menu');
  const isMulti = g.selection_type === 'multiple';
  // Names are the merchant's own words and go into the labels untouched; a blank one gets a generic label.
  const groupName = g.name.trim();
  return (
    <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-soft">
      {/* Header: group name + move + remove */}
      <div className="flex items-center gap-2 border-b border-border/60 bg-muted/30 px-3 py-2.5">
        <input
          value={g.name}
          onChange={(e) => onGroupChange({ name: e.target.value })}
          placeholder={t('modifiers.groupNamePlaceholder')}
          className="focus-ring min-w-0 flex-1 rounded-lg bg-transparent px-1.5 py-1 font-display text-base font-bold placeholder:font-sans placeholder:font-normal placeholder:text-muted-foreground"
        />
        <MoveButtons
          upLabel={groupName ? t('modifiers.move.groupUp', { name: groupName }) : t('modifiers.move.unnamedGroupUp')}
          downLabel={
            groupName ? t('modifiers.move.groupDown', { name: groupName }) : t('modifiers.move.unnamedGroupDown')
          }
          canMoveUp={canMoveUp}
          canMoveDown={canMoveDown}
          onMove={onMove}
          className="h-8 w-8 rounded-lg"
        />
        <button
          type="button"
          onClick={onRemoveGroup}
          title={t('modifiers.removeGroupTitle')}
          className="focus-ring inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-danger/10 hover:text-danger"
        >
          <Trash2 className="h-3.5 w-3.5" /> {t('modifiers.remove')}
        </button>
      </div>

      {/* Rules: selection type + required + max */}
      <div className="flex flex-wrap items-center gap-2 px-3 py-2.5">
        <div className="inline-flex rounded-full bg-muted p-0.5">
          <SegBtn active={!isMulti} onClick={() => onGroupChange({ selection_type: 'single', max_select: 1, min_select: g.is_required ? 1 : 0 })}>
            {t('modifiers.pickOne')}
          </SegBtn>
          <SegBtn active={isMulti} onClick={() => onGroupChange({ selection_type: 'multiple', max_select: Math.max(2, g.max_select) })}>
            {t('modifiers.pickMany')}
          </SegBtn>
        </div>

        {isMulti && (
          <div className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-1 text-xs">
            <span className="text-muted-foreground">{t('modifiers.upTo')}</span>
            <Stepper
              value={g.max_select}
              min={1}
              onChange={(v) => onGroupChange({ max_select: v })}
            />
          </div>
        )}

        <TogglePill on={g.is_required} onClick={() => onGroupChange({ is_required: !g.is_required, min_select: !g.is_required ? Math.max(1, g.min_select) : 0 })}>
          {g.is_required ? t('modifiers.required') : t('modifiers.optional')}
        </TogglePill>
      </div>

      {/* Options */}
      <div className="space-y-2 px-3 pb-3">
        {g.options.map((opt, index) => {
          const optionName = String(opt.name).trim();
          return (
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
                  placeholder={t('modifiers.optionNamePlaceholder')}
                  className="focus-ring min-w-0 flex-1 rounded-lg border border-border bg-card px-2.5 py-1.5 text-sm font-medium"
                />
                <MoveButtons
                  upLabel={
                    optionName
                      ? t('modifiers.move.optionUp', { name: optionName })
                      : t('modifiers.move.unnamedOptionUp')
                  }
                  downLabel={
                    optionName
                      ? t('modifiers.move.optionDown', { name: optionName })
                      : t('modifiers.move.unnamedOptionDown')
                  }
                  canMoveUp={index > 0}
                  canMoveDown={index < g.options.length - 1}
                  onMove={(dir) => onMoveOption(opt.id, dir)}
                  className="h-8 w-8 rounded-lg"
                />
                <button
                  type="button"
                  onClick={() => onRemoveOption(opt.id)}
                  title={t('modifiers.deleteOption')}
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
                  {t('modifiers.default')}
                </TogglePill>
                <TogglePill on={opt.is_active} onClick={() => onOptionChange(opt.id, { is_active: !opt.is_active })}>
                  {opt.is_active ? t('modifiers.active') : t('modifiers.hidden')}
                </TogglePill>
              </div>
            </div>
          );
        })}
        <button
          type="button"
          onClick={onAddOption}
          disabled={addingOption}
          aria-busy={addingOption || undefined}
          className="focus-ring flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border py-2 text-xs font-semibold text-primary transition-colors hover:border-primary/50 hover:bg-primary/5 disabled:pointer-events-none disabled:opacity-60"
        >
          <Plus className="h-3.5 w-3.5" /> {t('modifiers.addOption')}
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
  const t = useTranslations('menu');
  return (
    <span className="inline-flex items-center gap-1">
      <button
        type="button"
        onClick={() => onChange(Math.max(min, value - 1))}
        className="focus-ring grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-muted/70"
        aria-label={t('modifiers.decrease')}
      >
        <Minus className="h-3 w-3" />
      </button>
      <span className="w-4 text-center font-semibold tabular-nums">{value}</span>
      <button
        type="button"
        onClick={() => onChange(value + 1)}
        className="focus-ring grid h-5 w-5 place-items-center rounded-full bg-muted text-muted-foreground hover:bg-muted/70"
        aria-label={t('modifiers.increase')}
      >
        <Plus className="h-3 w-3" />
      </button>
    </span>
  );
}
