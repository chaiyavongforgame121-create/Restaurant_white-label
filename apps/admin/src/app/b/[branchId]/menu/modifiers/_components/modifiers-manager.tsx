'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronDown, ChevronUp, Info, Link2, Plus, Trash2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { compareByPosition } from '@favornoms/database/queries';
import { Badge, Button, Card, cn, useConfirm, usePrompt } from '@favornoms/ui';
import { MoveButtons, moveEntry, nextPosition, restoreOrder } from '../../_components/item-modifier-editor';
import { groupUsage, linkChanges, namePreview, stillLinkable, type GroupLink } from './modifier-usage';

interface Option {
  id: string;
  name: string;
  price_delta: number | string;
  is_default: boolean;
  is_active: boolean;
  display_order: number;
  /** Breaks position ties the way the storefront does. */
  created_at?: string | null;
}

interface Group {
  id: string;
  name: string;
  min_select: number;
  max_select: number;
  is_required: boolean;
  selection_type: 'single' | 'multiple';
  display_order: number;
  created_at?: string | null;
  modifier_options: Option[];
}

interface MenuItem {
  id: string;
  name: string;
  /** Each group on the dish, with the library group it was copied from when it is the dish's own copy. */
  menu_item_modifiers: GroupLink[];
}

interface Props {
  branchId: string;
  initialGroups: Group[];
  menuItems: MenuItem[];
}

type DbErrorKey =
  | 'permissionDenied'
  | 'network'
  | 'duplicate'
  | 'inUse'
  | 'branchMismatch'
  | 'invalidValue'
  | 'generic';

/** Raw PostgREST text never reaches the merchant: known codes get a translated sentence. */
function dbErrorKey(err: { code?: string; message?: string }): DbErrorKey {
  const message = err.message ?? '';
  if (err.code === '42501' || /row-level security|permission denied/i.test(message)) return 'permissionDenied';
  if (/failed to fetch|networkerror|network request failed/i.test(message)) return 'network';
  if (err.code === '23505') return 'duplicate';
  if (err.code === '23503') return 'inUse';
  // trg_menu_item_modifiers_same_branch (23514): a group may only be put on dishes of its own
  // branch. Checked before the generic 23xxx line, which would call it an invalid value.
  if (/modifier_group_branch_mismatch/.test(message)) return 'branchMismatch';
  if (err.code && /^(22|23)/.test(err.code)) return 'invalidValue';
  return 'generic';
}

/** Options in the order customers see them. */
function byPosition(options: readonly Option[]): Option[] {
  return options.slice().sort(compareByPosition);
}

/** Groups in a stable order: position, then age, then id, as everywhere else. */
function sortGroups(groups: readonly Group[]): Group[] {
  return groups.slice().sort(compareByPosition);
}

/** A thrown value in the shape dbError reads. */
function asDbError(err: unknown): { code?: string; message?: string } {
  return err && typeof err === 'object' ? (err as { code?: string; message?: string }) : { message: String(err) };
}

export function ModifiersManager({ branchId, initialGroups, menuItems }: Props) {
  const t = useTranslations('menuExtras');
  const router = useRouter();
  const confirm = useConfirm();
  const prompt = usePrompt();
  const [groups, setGroups] = React.useState(() => sortGroups(initialGroups));
  const [expandedId, setExpandedId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const dbError = (context: string, err: { code?: string; message?: string }) => {
    console.error(`[modifiers] ${context}`, err);
    return t(`errors.${dbErrorKey(err)}`);
  };

  // A move swaps two options on screen at once, then saves the group's whole list in its new order
  // with one call that renumbers every option 0..n-1 in a single statement (options deleted
  // meanwhile are skipped). One move saves at a time: clicks while it is saving are ignored.
  const movingRef = React.useRef(false);
  // Reads and moves overlap (every edit reads the list back): a read sent before a move was stored
  // can still hold the old order, and applying it would put the options back although the move
  // saved. So only the latest read is applied, and only if no move was saving at any point while
  // it was out; otherwise the list is read again once the move has settled.
  const readSeq = React.useRef(0);
  const movesSettled = React.useRef(0);
  const readAfterMove = React.useRef(false);

  const refetch = async () => {
    const supabase = getBrowserClient();
    for (;;) {
      const read = ++readSeq.current;
      const settledBefore = movesSettled.current;
      const { data, error: readErr } = await supabase
        .from('modifier_groups')
        .select(
          `id, name, min_select, max_select, is_required, selection_type, display_order, created_at,
           modifier_options(id, name, price_delta, is_default, is_active, display_order, created_at)`,
        )
        .eq('branch_id', branchId)
        // The library only, as the page loads it: dishes' own groups are edited in the dish.
        .is('owner_menu_item_id', null)
        .order('display_order');
      // A later read answers instead.
      if (read !== readSeq.current) return;
      if (movingRef.current) {
        readAfterMove.current = true;
        return;
      }
      // A move was stored while this read was out, so its answer may predate the move.
      if (movesSettled.current !== settledBefore) continue;
      if (readErr) {
        // Keep the list on screen rather than blank it.
        const message = dbError('load groups', readErr);
        setError((current) => current ?? message);
        return;
      }
      setGroups(sortGroups((data ?? []) as Group[]));
      return;
    }
  };

  // One add at a time, until the list is read back: a second click before that would give the new
  // row the same position as the first. Held from the first prompt, so a double click asks once.
  const creatingGroupRef = React.useRef(false);
  const [creatingGroup, setCreatingGroup] = React.useState(false);
  const addingOptionRef = React.useRef(new Set<string>());
  const [addingOptionTo, setAddingOptionTo] = React.useState<ReadonlySet<string>>(() => new Set());

  const createGroup = async () => {
    if (creatingGroupRef.current) return;
    creatingGroupRef.current = true;
    setCreatingGroup(true);
    try {
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
        display_order: nextPosition(groups),
      });
      if (insErr) {
        setError(dbError('create group', insErr));
        return;
      }
      await refetch();
    } finally {
      creatingGroupRef.current = false;
      setCreatingGroup(false);
    }
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

  /** `copies`: the dishes carrying their own copy of the group, which keep it (its source_group_id goes null). */
  const deleteGroup = async (id: string, copies: number) => {
    if (
      !(await confirm({
        title: t('modifiers.deleteGroupConfirm.title'),
        body:
          copies > 0
            ? t('modifiers.deleteGroupConfirm.bodyWithCopies', { count: copies })
            : t('modifiers.deleteGroupConfirm.body'),
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
    const adding = addingOptionRef.current;
    if (adding.has(groupId)) return;
    const markAdding = (on: boolean) => {
      if (on) adding.add(groupId);
      else adding.delete(groupId);
      setAddingOptionTo(new Set(adding));
    };
    markAdding(true);
    try {
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
        display_order: nextPosition(grp?.modifier_options ?? []),
      });
      if (insErr) {
        setError(dbError('add option', insErr));
        return;
      }
      await refetch();
    } finally {
      markAdding(false);
    }
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

  const moveOption = async (groupId: string, optionId: string, dir: -1 | 1) => {
    if (movingRef.current) return;
    const group = groups.find((g) => g.id === groupId);
    if (!group) return;
    const before = byPosition(group.modifier_options);
    const after = moveEntry(before, optionId, dir);
    if (!after) return;
    const setOptions = (update: (options: Option[]) => Option[]) =>
      setGroups((curr) =>
        curr.map((g) => (g.id === groupId ? { ...g, modifier_options: update(g.modifier_options) } : g)),
      );
    setOptions(() => after);
    movingRef.current = true;
    setError(null);
    let failure: { code?: string; message?: string } | null = null;
    try {
      const { error: rpcErr } = await getBrowserClient().rpc('reorder_modifier_options', {
        p_group_id: groupId,
        p_option_ids: after.map((o) => o.id),
      });
      failure = rpcErr;
    } catch (err) {
      failure = asDbError(err);
    } finally {
      movingRef.current = false;
      movesSettled.current += 1;
    }
    // The call is one statement, so a failure stored nothing: put the previous order back.
    if (failure) {
      setOptions((curr) => restoreOrder(curr, before));
      setError(dbError('reorder options', failure));
    }
    // Show what is really stored after a failure, or when a read was held back while this saved.
    if (failure || readAfterMove.current) {
      readAfterMove.current = false;
      await refetch();
    }
  };

  const linkToItems = async (groupId: string, itemIds: Set<string>) => {
    const supabase = getBrowserClient();
    // Dishes carrying their own copy of the group are neither linked nor unlinked (linkChanges).
    const { toAdd, toRemove } = linkChanges(menuItems, groupId, itemIds);

    if (toRemove.length > 0) {
      const { error: delErr } = await supabase
        .from('menu_item_modifiers')
        .delete()
        .eq('modifier_group_id', groupId)
        .in('menu_item_id', toRemove);
      if (delErr) setError(dbError('unlink items', delErr));
    }
    if (toAdd.length > 0) {
      // A link's position orders the groups of that one item, so the group goes after the groups
      // each item already has. Read by branch rather than by item id: a long id list can outgrow the URL.
      // The same read skips a dish that got the group, or its own copy of it, since the page loaded.
      const { data: items, error: posErr } = await supabase
        .from('menu_items')
        .select('id, menu_item_modifiers(display_order, modifier_group_id, modifier_groups(source_group_id))')
        .eq('branch_id', branchId);
      if (posErr) {
        setError(dbError('read item option positions', posErr));
      } else {
        const rows = items ?? [];
        const nextByItem = new Map(rows.map((m) => [m.id, nextPosition(m.menu_item_modifiers ?? [])]));
        const adding = stillLinkable(rows, groupId, toAdd);
        if (adding.length > 0) {
          const { error: insErr } = await supabase.from('menu_item_modifiers').insert(
            adding.map((mid) => ({
              menu_item_id: mid,
              modifier_group_id: groupId,
              display_order: nextByItem.get(mid) ?? 0,
            })),
          );
          if (insErr) setError(dbError('link items', insErr));
        }
      }
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
        <Button
          variant="gradient"
          onClick={createGroup}
          disabled={creatingGroup}
          leftIcon={<Plus className="h-4 w-4" />}
        >
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
            // `customized`: dishes showing their own copy of the group, which edits here don't reach.
            const { linked, customized } = groupUsage(menuItems, g.id);
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
                          {customized.length > 0 && (
                            <>
                              {' · '}
                              {t('modifiers.customizedCount', { count: customized.length })}
                            </>
                          )}
                        </p>
                      </div>
                    </button>
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => deleteGroup(g.id, customized.length)}
                        leftIcon={<Trash2 className="h-4 w-4" />}
                      >
                        {t('modifiers.delete')}
                      </Button>
                    </div>
                  </div>

                  {expandedId === g.id && (
                    <div className="mt-4 space-y-4 border-t border-border/60 pt-4">
                      {customized.length > 0 && <CustomizedNote items={customized} />}
                      <GroupSettings group={g} onChange={(patch) => updateGroup(g.id, patch)} />

                      <div>
                        <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                          {t('modifiers.options')}
                        </p>
                        <ul className="space-y-2">
                          {byPosition(g.modifier_options).map((opt, index, list) => {
                            // Option names are the merchant's own words and go into the labels untouched.
                            const optionName = opt.name.trim();
                            return (
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
                                  <div className="flex items-center gap-1">
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
                                      canMoveDown={index < list.length - 1}
                                      onMove={(dir) => void moveOption(g.id, opt.id, dir)}
                                    />
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => deleteOption(opt.id)}
                                      leftIcon={<Trash2 className="h-3.5 w-3.5" />}
                                    >
                                      {t('modifiers.remove')}
                                    </Button>
                                  </div>
                                </div>
                              </li>
                            );
                          })}
                        </ul>
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-2"
                          onClick={() => addOption(g.id)}
                          disabled={addingOptionTo.has(g.id)}
                          leftIcon={<Plus className="h-4 w-4" />}
                        >
                          {t('modifiers.addOption')}
                        </Button>
                      </div>

                      <LinkPicker
                        groupId={g.id}
                        menuItems={menuItems}
                        linked={linked}
                        customized={customized}
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

/**
 * Which dishes carry their own copy of the group. They were changed in the dish's editor, which
 * copies the group onto that one dish, so an edit made here no longer reaches them.
 */
function CustomizedNote({ items }: { items: MenuItem[] }) {
  const t = useTranslations('menuExtras.modifiers');
  // Item names are the merchant's own words, so they go into the sentence untouched.
  const { names, more } = namePreview(items);
  return (
    <p className="flex items-start gap-2 rounded-xl bg-info/10 px-3 py-2 text-sm text-foreground">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-info" />
      <span>
        {more > 0 ? t('customizedNoteMore', { names, more }) : t('customizedNote', { names, count: items.length })}
      </span>
    </p>
  );
}

function LinkPicker({
  groupId,
  menuItems,
  linked,
  customized,
  onSave,
}: {
  groupId: string;
  menuItems: MenuItem[];
  linked: MenuItem[];
  /** Dishes carrying their own copy of the group: shown, but their box can't be ticked. */
  customized: MenuItem[];
  onSave: (itemIds: Set<string>) => void;
}) {
  const t = useTranslations('menuExtras.modifiers.links');
  const [open, setOpen] = React.useState(false);
  const [selected, setSelected] = React.useState<Set<string>>(() => new Set(linked.map((m) => m.id)));
  const customizedIds = new Set(customized.map((m) => m.id));
  const hintId = React.useId();

  // `linked` is a new array on every render of the page (a move, an edit, a read coming back), so
  // the ticks are reset only when the linked items themselves change -- not while the merchant is
  // still choosing.
  const linkedKey = linked
    .map((m) => m.id)
    .sort()
    .join(' ');
  React.useEffect(() => {
    setSelected(new Set(linkedKey ? linkedKey.split(' ') : []));
  }, [linkedKey]);

  // Item names are the merchant's own words, so they go into the sentence untouched.
  const { names, more } = namePreview(linked);

  return (
    <div className="rounded-xl border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-medium">
          {linked.length === 0
            ? t.rich('none', { muted: (chunks) => <span className="text-muted-foreground">{chunks}</span> })
            : more > 0
              ? t('linkedToMore', { names, count: more })
              : t('linkedTo', { names })}
        </p>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            // Cancel drops the unsaved ticks, so the next Edit starts from what is linked.
            if (open) setSelected(new Set(linked.map((m) => m.id)));
            setOpen(!open);
          }}
          leftIcon={<Link2 className="h-3.5 w-3.5" />}
        >
          {open ? t('cancel') : t('edit')}
        </Button>
      </div>
      {open && (
        <div className="mt-3 space-y-2">
          <div className="max-h-56 overflow-y-auto rounded-lg border border-border bg-card p-2">
            {menuItems.map((m) => {
              // Ticking a dish that carries its own copy would put the library group and the copy
              // on one dish; Save links leaves it alone either way.
              const isCustomized = customizedIds.has(m.id);
              return (
                <label
                  key={m.id}
                  className={cn(
                    'flex items-center gap-2 rounded px-2 py-1 text-sm',
                    isCustomized ? 'cursor-not-allowed text-muted-foreground' : 'hover:bg-muted',
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    disabled={isCustomized}
                    aria-describedby={isCustomized ? hintId : undefined}
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
                  {isCustomized ? (
                    <Badge variant="info" className="ml-auto">
                      {t('customized')}
                    </Badge>
                  ) : (
                    selected.has(m.id) && <Badge variant="success" className="ml-auto">{t('linked')}</Badge>
                  )}
                </label>
              );
            })}
            {menuItems.length === 0 && (
              <p className="px-2 py-3 text-xs text-muted-foreground">{t('noItems')}</p>
            )}
          </div>
          {customized.length > 0 && (
            <p id={hintId} className="text-xs text-muted-foreground">
              {t('customizedHint')}
            </p>
          )}
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
