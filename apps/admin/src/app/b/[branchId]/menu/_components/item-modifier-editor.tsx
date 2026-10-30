'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Check, ChevronDown, ChevronUp, Library, Minus, Plus, Trash2, Undo2, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, cn, IconButton, useConfirm } from '@favornoms/ui';
import { menuErrorKey } from './menu-errors';
import {
  changeDraftGroup,
  changedFields,
  copyErrorKey,
  draftProblem,
  draftSteps,
  groupFromRow,
  groupKind,
  groupsFromLinks,
  GroupWrites,
  isGroupGone,
  isSourceRefusal,
  keepKeys,
  libraryChoices,
  parseGroupCopy,
  parseResetAnswer,
  showCopy,
  type GroupPatch,
  type GroupRow,
  type MGroup,
  type OptionPatch,
  type WriteResult,
  type WriteTarget,
} from './item-modifier-model';

// Per-item modifier editor — this dish's option groups (Size, Add-ons, …) and their options, right
// inside the item editor. A group from the Modifier groups page (the library, /menu/modifiers) is
// shown here as it is there. The first change made to it here gives the dish its own copy and saves
// the change on the copy, so the library group and the other dishes that show it never change from
// this screen (item-modifier-model.ts has the rules). "Remove" takes a library group off this dish
// only, and deletes a group of the dish's own; "Add group" makes one for this dish only.

const GROUP_SELECT = `display_order, modifier_groups!inner(
  id, name, selection_type, is_required, min_select, max_select, display_order, created_at,
  owner_menu_item_id, source_group_id,
  modifier_options(id, name, price_delta, is_default, is_active, display_order, created_at)
)`;

// The library's groups, with their options: a dish not saved yet shows a picked group as it is.
const LIBRARY_SELECT = `id, name, selection_type, is_required, min_select, max_select, display_order, created_at,
  owner_menu_item_id, source_group_id,
  modifier_options(id, name, price_delta, is_default, is_active, display_order, created_at)`;

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

/**
 * `current` put back in the order and positions of `snapshot`, keeping edits made in the meantime.
 * `idOf` gives the id a row has now, for rows whose id can change meanwhile (a dish's copy of a
 * library group replacing the library group's ids).
 */
export function restoreOrder<T extends Positioned>(
  current: readonly T[],
  snapshot: readonly T[],
  idOf: (id: string) => string = (id) => id,
): T[] {
  const before = new Map(snapshot.map((row, index) => [idOf(row.id), { index, position: row.display_order }]));
  const rank = (row: T) => before.get(idOf(row.id))?.index ?? snapshot.length;
  return current
    .slice()
    .sort((a, b) => rank(a) - rank(b))
    .map((row) => {
      const was = before.get(idOf(row.id));
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

// `itemId` is null while creating a new item. In that "draft" mode every edit
// stays in local React state (temp ids) and nothing touches the DB until the
// parent saves the item and calls persistDraft(); for an existing item each
// tweak is written through at once, to the dish's own groups only.
export const ItemModifierEditor = React.forwardRef<
  ItemModifierEditorHandle,
  { branchId: string; itemId: string | null }
>(function ItemModifierEditor({ branchId, itemId }, ref) {
  const t = useTranslations('menu');
  const isDraft = !itemId;
  const [groups, setGroups] = React.useState<MGroup[]>([]);
  const [loading, setLoading] = React.useState(!isDraft);
  // The dish's groups have been read at least once (a new dish has none to read). Before that the
  // list is empty, so "Add from Modifier groups" would offer groups the dish already shows (the
  // source of its own copy among them) and the dish would show that group twice.
  const [loaded, setLoaded] = React.useState(isDraft);
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

  /** errorText, with the copy and reset functions' own refusals in their own words. */
  const copyErrorText = React.useCallback(
    (context: string, err: unknown) => {
      const key = copyErrorKey(err);
      if (!key) return errorText(context, err);
      console.error(`[menu] ${context} failed`, err);
      return t(`modifiers.copyErrors.${key}`);
    },
    [errorText, t],
  );

  // A move swaps two neighbours on screen at once, then saves the whole list in its new order with
  // one call that renumbers every row 0..n-1 in a single statement (rows deleted meanwhile are
  // skipped). One move saves at a time: clicks while it is saving are ignored.
  const movingRef = React.useRef(false);
  // Reads overlap moves and the writes queued for each group (getWrites below; a copy is made inside
  // one): a read sent before they were stored can still hold the old order, the library group's ids
  // or the value before a keystroke, and applying it would put that back over what is on screen. So
  // only the latest read is applied, and only if nothing was saving at any point while it was out;
  // otherwise the list is read again once everything has settled.
  const readSeq = React.useRef(0);
  const movesSettled = React.useRef(0);
  const readHeld = React.useRef(false);
  // The saved dish's write queue (getWrites), declared here for the read to consult.
  const writesRef = React.useRef<{ itemId: string; writes: GroupWrites } | null>(null);
  const changesInFlight = () => movingRef.current || (writesRef.current?.writes.pending ?? 0) > 0;
  const changesSettled = () => movesSettled.current + (writesRef.current?.writes.settled ?? 0);
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
      const settledBefore = changesSettled();
      const { data, error: readError } = await supabase
        .from('menu_item_modifiers')
        .select(GROUP_SELECT)
        .eq('menu_item_id', itemId)
        .order('display_order');
      // A later read answers instead.
      if (read !== readSeq.current) return;
      if (changesInFlight()) {
        readHeld.current = true;
        return;
      }
      // A move or a write was stored while this read was out, so its answer may predate it.
      if (changesSettled() !== settledBefore) continue;
      if (readError) {
        // Keep the list on screen rather than blank it.
        const message = errorTextRef.current('load option groups', readError);
        setError((current) => current ?? message);
        setLoading(false);
        return;
      }
      const fresh = groupsFromLinks(data ?? [], itemId);
      // Keyed like the rows on screen, so a card being typed in keeps the focus.
      setGroups((current) => keepKeys(fresh, current));
      setLoaded(true);
      setLoading(false);
      return;
    }
    // changesInFlight and changesSettled read refs only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemId]);

  React.useEffect(() => {
    if (itemId) void fetchGroups();
  }, [itemId, fetchGroups]);

  // The write queue below is made once per dish and outlives a render, so it reaches these through refs.
  const fetchGroupsRef = React.useRef(fetchGroups);
  const reportCopyFailureRef = React.useRef<(err: unknown) => void>(() => undefined);
  React.useEffect(() => {
    fetchGroupsRef.current = fetchGroups;
    reportCopyFailureRef.current = (err) =>
      setError(t('modifiers.copyFailed', { reason: copyErrorText('copy option group', err) }));
  }, [fetchGroups, copyErrorText, t]);

  /** A read held back while something was saving goes out once nothing is. */
  const readIfHeld = () => {
    if (!readHeld.current || changesInFlight()) return;
    readHeld.current = false;
    void fetchGroupsRef.current();
  };

  // The saved dish's writes to its groups (GroupWrites): one queue per group, and the dish's own copy
  // made on the first change to a library group. Made on first use, once per dish.
  const getWrites = (): GroupWrites | null => {
    if (!itemId) return null;
    if (writesRef.current?.itemId !== itemId) {
      const menuItemId = itemId;
      writesRef.current = {
        itemId,
        writes: new GroupWrites({
          copy: async (groupId) => {
            const { data, error: copyError } = await getBrowserClient().rpc('customize_item_modifier_group', {
              p_menu_item_id: menuItemId,
              p_group_id: groupId,
            });
            if (copyError) throw copyError;
            const made = parseGroupCopy(data);
            if (!made) throw new Error('customize_item_modifier_group answered in an unknown shape');
            return made;
          },
          onCopied: (fromId, made) => setGroups((current) => showCopy(current, fromId, made)),
          onCopyFailed: (_fromId, err) => {
            // Nothing was stored, so the change on screen must not look saved: the list is read
            // back once the writes still queued have settled.
            reportCopyFailureRef.current(err);
            readHeld.current = true;
          },
          onSettled: readIfHeld,
        }),
      };
    }
    return writesRef.current.writes;
  };

  /** On screen, rows `a` and `b` are the same group: one id, or a library group's and its copy's. */
  const sameGroup = (a: string, b: string) => {
    if (a === b) return true;
    const writes = writesRef.current?.writes;
    return !!writes && writes.groupId(a) === writes.groupId(b);
  };
  /** The same for options. */
  const sameOption = (a: string, b: string) => {
    if (a === b) return true;
    const writes = writesRef.current?.writes;
    return !!writes && writes.optionId(a) === writes.optionId(b);
  };
  const groupIdNow = (id: string) => writesRef.current?.writes.groupId(id) ?? id;
  const optionIdNow = (id: string) => writesRef.current?.writes.optionId(id) ?? id;

  // Block save while a group of the dish's own is half-built (draftProblem).
  const validateDraft = React.useCallback((): string | null => {
    const problem = draftProblem(groups);
    if (!problem) return null;
    return problem.key === 'groupName'
      ? t('modifiers.validation.groupName')
      : t(`modifiers.validation.${problem.key}`, { group: problem.group });
  }, [groups, t]);

  // Flush a new dish's groups once the dish has been inserted and has an id (draftSteps). A library
  // group left as it is only gets a link: the dish shows the library group itself. A group of the
  // dish's own is inserted owned by the dish, then its options, then the item link LAST, so a
  // mid-way failure leaves an unlinked (invisible, harmless) group rather than a linked group with
  // no options that would dead-end the customer cart.
  const persistDraft = React.useCallback(
    async (newItemId: string): Promise<{ error?: string }> => {
      const supabase = getBrowserClient();
      let skipped: string | undefined;
      for (const step of draftSteps(groups)) {
        if (step.kind === 'link') {
          const { error: le } = await supabase
            .from('menu_item_modifiers')
            .insert({ menu_item_id: newItemId, modifier_group_id: step.groupId, display_order: step.position });
          if (!le) continue;
          // Deleted from Modifier groups since it was picked: the dish's other groups still go on.
          if (isGroupGone(le)) {
            console.error('[menu] link option group failed', le);
            skipped ??= t('modifiers.library.goneNamed', { group: step.name || t('modifiers.library.unnamed') });
            continue;
          }
          return { error: errorText('link option group', le) };
        }
        const insertGroup = (sourceGroupId: string | null) =>
          supabase
            .from('modifier_groups')
            .insert({
              branch_id: branchId,
              owner_menu_item_id: newItemId,
              source_group_id: sourceGroupId,
              ...step.group,
              display_order: step.position,
            })
            .select('id')
            .single();
        let { data: gRow, error: ge } = await insertGroup(step.sourceGroupId);
        // The library group it was copied from was deleted (or left the library) since it was
        // picked: the dish keeps its own version, as a group made for it.
        if (ge && step.sourceGroupId && isSourceRefusal(ge)) {
          console.error('[menu] save option group copy failed', ge);
          ({ data: gRow, error: ge } = await insertGroup(null));
        }
        if (ge || !gRow) {
          return { error: ge ? errorText('save option group', ge) : t('modifiers.groupSaveFailed') };
        }
        const groupId = gRow.id;
        if (step.options.length) {
          const { error: oe } = await supabase
            .from('modifier_options')
            .insert(step.options.map((o) => ({ group_id: groupId, ...o })));
          if (oe) return { error: errorText('save options', oe) };
        }
        const { error: le } = await supabase
          .from('menu_item_modifiers')
          .insert({ menu_item_id: newItemId, modifier_group_id: groupId, display_order: step.position });
        if (le) return { error: errorText('link option group', le) };
      }
      return skipped ? { error: skipped } : {};
    },
    [groups, branchId, errorText, t],
  );

  React.useImperativeHandle(ref, () => ({ validateDraft, persistDraft }), [validateDraft, persistDraft]);

  // One add at a time, until the list is read back: a second click before that would give the new
  // row the same position as the first. Options are tracked by the card's key, which survives the
  // dish's copy replacing the library group's ids.
  const addingGroupRef = React.useRef(false);
  const addingOptionRef = React.useRef(new Set<string>());
  const [addingOptionTo, setAddingOptionTo] = React.useState<ReadonlySet<string>>(() => new Set());
  // Cards with a Remove or a "Use the library version" on its way: nothing in them can be changed.
  const [lockedKeys, setLockedKeys] = React.useState<ReadonlySet<string>>(() => new Set());
  const lockGroup = (key: string, on: boolean) =>
    setLockedKeys((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const addGroup = async () => {
    if (isDraft) {
      const id = newTmpId();
      setGroups((cur) => [
        ...cur,
        {
          id,
          key: id,
          name: '',
          selection_type: 'single',
          is_required: false,
          min_select: 0,
          max_select: 1,
          display_order: nextPosition(cur),
          options: [],
          own: true,
          sourceGroupId: null,
        },
      ]);
      return;
    }
    if (addingGroupRef.current || !itemId) return;
    const menuItemId = itemId;
    addingGroupRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const position = nextPosition(groups);
      const supabase = getBrowserClient();
      // The dish's own: the Modifier groups page never lists it and no other dish can show it.
      const { data: g, error: e } = await supabase
        .from('modifier_groups')
        .insert({
          branch_id: branchId,
          owner_menu_item_id: menuItemId,
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
        .insert({ menu_item_id: menuItemId, modifier_group_id: g.id, display_order: position });
      if (le) {
        setError(errorText('link option group', le));
        // Unlinked, it would show nowhere: it belongs to this dish and to no list.
        await supabase.from('modifier_groups').delete().eq('id', g.id).eq('owner_menu_item_id', menuItemId);
        return;
      }
      await fetchGroups();
    } finally {
      addingGroupRef.current = false;
      setBusy(false);
    }
  };

  /**
   * Shows a change to one group at once. On a dish not saved yet that is the whole edit, and a picked
   * library group becomes the dish's own copy first (changeDraftGroup). On a saved dish the write
   * follows (writeChange), and the row may still carry the library group's ids or already its copy's.
   */
  const showChange = (
    groupId: string,
    change: (group: MGroup, same: (rowId: string, eventId: string) => boolean) => MGroup,
  ) => {
    if (isDraft) {
      setGroups((cur) => changeDraftGroup(cur, groupId, newTmpId, change));
      return;
    }
    setGroups((cur) => cur.map((g) => (sameGroup(g.id, groupId) ? change(g, sameOption) : g)));
  };

  /**
   * Writes a change to a group of the saved dish, after the writes already queued for it. It goes to
   * the dish's own group: the first change to a library group waits for the dish's copy and lands on
   * it, never on the library group. Resolves null when that copy failed (already said, and the list
   * read back).
   */
  const writeChange = async (
    group: MGroup,
    context: string,
    write: (to: WriteTarget, menuItemId: string) => PromiseLike<WriteResult>,
  ): Promise<WriteResult | null> => {
    const writes = getWrites();
    if (!writes || !itemId) return null;
    const menuItemId = itemId;
    const result = await writes.run(group, (to) => write(to, menuItemId), { copy: true });
    if (result?.error) setError(errorText(context, result.error));
    return result;
  };

  // Every write below names the dish's own group: the owner filter on a group, and the group filter
  // on an option, keep a library row out of reach even if the screen were wrong about a group.
  const updateGroup = (group: MGroup, rawPatch: GroupPatch) => {
    // A click that changes nothing writes nothing: on a library group it would make the dish's copy
    // (on a dish not saved yet, a draft copy), cutting the dish off from the library group.
    const patch = changedFields(group, rawPatch);
    if (Object.keys(patch).length === 0) return;
    showChange(group.id, (g) => ({ ...g, ...patch }));
    if (isDraft) return;
    void writeChange(group, 'update option group', (to, menuItemId) =>
      getBrowserClient().from('modifier_groups').update(patch).eq('id', to.groupId).eq('owner_menu_item_id', menuItemId),
    );
  };

  // Remove: a library group only stops showing on this dish (it stays on the Modifier groups page
  // and on the other dishes that show it); a group of the dish's own is deleted, as it is on no other
  // list. The dish editor never deletes a library group.
  const removeGroup = async (group: MGroup) => {
    const own = group.own;
    if (
      !(await confirm({
        title: own ? t('modifiers.removeConfirm.ownTitle') : t('modifiers.removeConfirm.libraryTitle'),
        body: own ? t('modifiers.removeConfirm.ownBody') : t('modifiers.removeConfirm.libraryBody'),
        confirmLabel: own ? t('modifiers.removeConfirm.delete') : t('modifiers.removeConfirm.remove'),
        destructive: true,
      }))
    ) {
      return;
    }
    if (isDraft) {
      setGroups((cur) => cur.filter((g) => g.key !== group.key));
      return;
    }
    const writes = getWrites();
    if (!writes || !itemId) return;
    const menuItemId = itemId;
    lockGroup(group.key, true);
    try {
      // Behind the writes queued for the group: a copy still being made is the dish's own once made.
      const result = await writes.run(
        group,
        async (to) => {
          const supabase = getBrowserClient();
          if (to.own) {
            // Its options and its link go with it.
            const { data, error: deleteError } = await supabase
              .from('modifier_groups')
              .delete()
              .eq('id', to.groupId)
              .eq('owner_menu_item_id', menuItemId)
              .select('id');
            if (deleteError || (data?.length ?? 0) > 0) return { error: deleteError };
          }
          const { data: unlinked, error: unlinkError } = await supabase
            .from('menu_item_modifiers')
            .delete()
            .eq('menu_item_id', menuItemId)
            .eq('modifier_group_id', to.groupId)
            .select('modifier_group_id');
          if (unlinkError) return { error: unlinkError };
          // Nothing matched: another tab made the dish's copy of this group, put the library version
          // back, or took it off the dish, so the dish no longer shows it as this screen does.
          return { error: unlinked?.length ? null : { message: 'modifier_link_not_found' } };
        },
        { copy: false },
      );
      if (result?.error) setError(copyErrorText('remove option group', result.error));
      await fetchGroups();
    } finally {
      lockGroup(group.key, false);
    }
  };

  // "Use the library version": the dish shows the library group its copy was made from again, where
  // the copy was, and the copy is deleted.
  const resetGroup = async (group: MGroup) => {
    const sourceGroupId = group.sourceGroupId;
    if (!sourceGroupId) return;
    if (
      !(await confirm({
        title: t('modifiers.resetConfirm.title'),
        body: t('modifiers.resetConfirm.body'),
        confirmLabel: t('modifiers.resetConfirm.confirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    setError(null);
    lockGroup(group.key, true);
    try {
      if (isDraft) {
        // Nothing is saved yet: the draft copy is swapped back for the library group as it is now.
        const { data, error: readError } = await getBrowserClient()
          .from('modifier_groups')
          .select(LIBRARY_SELECT)
          .eq('id', sourceGroupId)
          .is('owner_menu_item_id', null)
          .maybeSingle();
        if (readError) {
          setError(errorText('read option group', readError));
        } else if (!data) {
          setError(t('modifiers.copyErrors.sourceMissing'));
        } else {
          const library = groupFromRow(data, group.display_order, null);
          setGroups((cur) => cur.map((g) => (g.key === group.key ? { ...library, key: g.key } : g)));
        }
        return;
      }
      const writes = getWrites();
      if (!writes || !itemId) return;
      const menuItemId = itemId;
      let sourceGone = false;
      const result = await writes.run(
        group,
        async (to) => {
          if (!to.own) return { error: null };
          const supabase = getBrowserClient();
          const { data: back, error: resetError } = await supabase.rpc('reset_item_modifier_group', {
            p_menu_item_id: menuItemId,
            p_group_id: to.groupId,
          });
          if (!resetError) {
            // Its next change here makes a new copy, and a group move names the library group again.
            writes.forget(to.groupId, parseResetAnswer(back) ?? sourceGroupId);
          } else if (copyErrorKey(resetError) === 'listChanged') {
            // Still the dish's own, with no source: its library group was deleted since this screen
            // showed it as a copy (the foreign key cleared the source), so there is nothing to go back to.
            const { data: now } = await supabase
              .from('modifier_groups')
              .select('source_group_id')
              .eq('id', to.groupId)
              .eq('owner_menu_item_id', menuItemId)
              .maybeSingle();
            sourceGone = !!now && !now.source_group_id;
          }
          return { error: resetError };
        },
        { copy: false },
      );
      if (result?.error && sourceGone) {
        console.error('[menu] use the library version failed', result.error);
        setError(t('modifiers.copyErrors.sourceMissing'));
      } else if (result?.error) {
        setError(copyErrorText('use the library version', result.error));
      }
      await fetchGroups();
    } finally {
      lockGroup(group.key, false);
    }
  };

  const addOption = async (group: MGroup) => {
    if (isDraft) {
      const id = newTmpId();
      showChange(group.id, (g) => ({
        ...g,
        options: [
          ...g.options,
          {
            id,
            key: id,
            name: '',
            price_delta: 0,
            is_default: false,
            is_active: true,
            display_order: nextPosition(g.options),
          },
        ],
      }));
      return;
    }
    const adding = addingOptionRef.current;
    if (adding.has(group.key)) return;
    const markAdding = (on: boolean) => {
      if (on) adding.add(group.key);
      else adding.delete(group.key);
      setAddingOptionTo(new Set(adding));
    };
    markAdding(true);
    try {
      const result = await writeChange(group, 'add option', (to) =>
        getBrowserClient()
          .from('modifier_options')
          .insert({
            group_id: to.groupId,
            name: '',
            price_delta: 0,
            is_default: false,
            is_active: true,
            display_order: nextPosition(group.options),
          }),
      );
      if (result && !result.error) await fetchGroups();
    } finally {
      markAdding(false);
    }
  };

  const updateOption = (group: MGroup, optId: string, patch: OptionPatch) => {
    showChange(group.id, (g, same) => ({
      ...g,
      options: g.options.map((o) => (same(o.id, optId) ? { ...o, ...patch } : o)),
    }));
    if (isDraft) return;
    void writeChange(group, 'update option', (to) =>
      getBrowserClient()
        .from('modifier_options')
        .update(patch)
        .eq('id', to.optionId(optId))
        .eq('group_id', to.groupId),
    );
  };

  // "Default" behaves like a radio in single-select groups: turning one on clears the others.
  const toggleDefault = (group: MGroup, optId: string) => {
    const next = !group.options.find((o) => o.id === optId)?.is_default;
    if (group.selection_type !== 'single' || !next) {
      updateOption(group, optId, { is_default: next });
      return;
    }
    showChange(group.id, (g, same) => ({
      ...g,
      options: g.options.map((o) => ({ ...o, is_default: same(o.id, optId) })),
    }));
    if (isDraft) return;
    void writeChange(group, 'update option', async (to) => {
      const supabase = getBrowserClient();
      const chosen = to.optionId(optId);
      const on = await supabase.from('modifier_options').update({ is_default: true }).eq('id', chosen).eq('group_id', to.groupId);
      if (on.error) return on;
      return supabase
        .from('modifier_options')
        .update({ is_default: false })
        .eq('group_id', to.groupId)
        .eq('is_default', true)
        .neq('id', chosen);
    });
  };

  const removeOption = async (group: MGroup, optId: string) => {
    if (isDraft) {
      showChange(group.id, (g, same) => ({ ...g, options: g.options.filter((o) => !same(o.id, optId)) }));
      return;
    }
    const result = await writeChange(group, 'delete option', (to) =>
      getBrowserClient().from('modifier_options').delete().eq('id', to.optionId(optId)).eq('group_id', to.groupId),
    );
    if (result) await fetchGroups();
  };

  // Saves a move already shown on screen. The call is one statement, so a failure stored nothing:
  // the previous order goes back on screen and the list is read again. A draft (item not saved yet)
  // never gets here; persistDraft numbers rows by their index, so the saved order is the one on screen.
  // `save` resolves null when the dish's copy the move needed failed (already said): nothing moved.
  const saveMove = async (
    context: string,
    save: () => PromiseLike<WriteResult | null>,
    restore: () => void,
  ) => {
    movingRef.current = true;
    setError(null);
    let failure: unknown = null;
    let dropped = false;
    try {
      const result = await save();
      if (result) failure = result.error;
      else dropped = true;
    } catch (err) {
      failure = err ?? new Error(`${context} threw`);
    } finally {
      movingRef.current = false;
      movesSettled.current += 1;
    }
    if (failure || dropped) restore();
    if (failure) setError(errorText(context, failure));
    // Show what is really stored after a failure, or when a read was held back while this saved.
    if (failure || dropped || readHeld.current) {
      readHeld.current = false;
      await fetchGroups();
    }
  };

  // Moving a group is this dish's own business (menu_item_modifiers.display_order): no copy is made.
  const moveGroup = (groupId: string, dir: -1 | 1) => {
    if (movingRef.current) return;
    const before = groups;
    const after = moveEntry(before, groupId, dir);
    if (!after) return;
    setGroups((cur) => restoreOrder(cur, after, groupIdNow));
    const writes = getWrites();
    if (!writes || !itemId) return;
    const menuItemId = itemId;
    void saveMove(
      'reorder option groups',
      // A copy being made, or a "Use the library version", moves the dish's link to another id. The
      // order goes once the writes already queued have landed, with the ids the dish shows then (read
      // inside), and holds back the ones made meanwhile until it is stored: an id it does not name
      // would put that group last.
      () =>
        writes.exclusive(() =>
          getBrowserClient().rpc('reorder_item_modifier_groups', {
            p_menu_item_id: menuItemId,
            p_group_ids: after.map((g) => writes.groupId(g.id)),
          }),
        ),
      () => setGroups((cur) => restoreOrder(cur, before, groupIdNow)),
    );
  };

  // Moving an option changes the group, so on a library group it is saved on the dish's copy.
  const moveOption = (group: MGroup, optId: string, dir: -1 | 1) => {
    if (movingRef.current) return;
    const before = group.options;
    const after = moveEntry(before, optId, dir);
    if (!after) return;
    showChange(group.id, (g, same) => {
      const moved = g.options.find((o) => same(o.id, optId));
      return moved ? { ...g, options: moveEntry(g.options, moved.id, dir) ?? g.options } : g;
    });
    const writes = getWrites();
    if (!writes) return;
    void saveMove(
      'reorder options',
      () =>
        writes.run(
          group,
          (to) =>
            getBrowserClient().rpc('reorder_modifier_options', {
              p_group_id: to.groupId,
              p_option_ids: after.map((o) => to.optionId(o.id)),
            }),
          { copy: true },
        ),
      () =>
        setGroups((cur) =>
          cur.map((g) =>
            sameGroup(g.id, group.id) ? { ...g, options: restoreOrder(g.options, before, optionIdNow) } : g,
          ),
        ),
    );
  };

  // ── "Add from Modifier groups" ────────────────────────────────────────────────────────────
  const [libraryOpen, setLibraryOpen] = React.useState(false);
  /** The library's groups, read when the list is opened; null while that read is out. */
  const [library, setLibrary] = React.useState<GroupRow[] | null>(null);
  const librarySeq = React.useRef(0);
  const addingFromLibraryRef = React.useRef(false);
  const [addingFromLibrary, setAddingFromLibrary] = React.useState<string | null>(null);

  const loadLibrary = async () => {
    const read = ++librarySeq.current;
    const { data, error: readError } = await getBrowserClient()
      .from('modifier_groups')
      .select(LIBRARY_SELECT)
      .eq('branch_id', branchId)
      .is('owner_menu_item_id', null)
      .order('display_order');
    if (read !== librarySeq.current) return;
    if (readError) {
      setError(errorText('load modifier groups', readError));
      setLibraryOpen(false);
      return;
    }
    setLibrary(data ?? []);
  };

  const toggleLibrary = () => {
    if (libraryOpen) {
      setLibraryOpen(false);
      return;
    }
    setLibrary(null);
    setLibraryOpen(true);
    void loadLibrary();
  };

  // The group is shown on the dish as it is in the library; a change made to it here later goes to
  // the dish's own copy.
  const addFromLibrary = async (row: GroupRow) => {
    if (isDraft) {
      setGroups((cur) =>
        libraryChoices([row], cur).length ? [...cur, groupFromRow(row, nextPosition(cur), null)] : cur,
      );
      return;
    }
    // Offered only once the dish's groups are read (`loaded`): the list it is checked against.
    if (addingFromLibraryRef.current || !itemId || !loaded) return;
    addingFromLibraryRef.current = true;
    setAddingFromLibrary(row.id);
    setError(null);
    try {
      const { error: linkError } = await getBrowserClient()
        .from('menu_item_modifiers')
        .insert({ menu_item_id: itemId, modifier_group_id: row.id, display_order: nextPosition(groups) });
      if (linkError && isGroupGone(linkError)) {
        console.error('[menu] link option group failed', linkError);
        setError(t('modifiers.library.gone'));
        void loadLibrary();
      } else if (linkError) {
        // modifier_group_owned_elsewhere: the dish shows its own copy of this group by now (made in
        // another tab), which the list read back below shows.
        setError(copyErrorText('link option group', linkError));
      }
      await fetchGroups();
    } finally {
      addingFromLibraryRef.current = false;
      setAddingFromLibrary(null);
    }
  };

  const choices = library && loaded ? libraryChoices(library, groups) : [];

  // Stop Enter inside these inputs from submitting the parent item form.
  const noEnterSubmit = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') e.preventDefault();
  };

  return (
    <div className="space-y-3" onKeyDown={noEnterSubmit}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold">{t('modifiers.title')}</p>
          <p className="text-xs text-muted-foreground">{t('modifiers.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={toggleLibrary}
            disabled={!loaded}
            aria-expanded={libraryOpen}
            leftIcon={<Library className="h-4 w-4" />}
          >
            {t('modifiers.addFromLibrary')}
          </Button>
          <Button type="button" variant="soft" size="sm" onClick={addGroup} loading={busy} leftIcon={<Plus className="h-4 w-4" />}>
            {t('modifiers.addGroup')}
          </Button>
        </div>
      </div>

      {libraryOpen && (
        <div className="rounded-2xl border border-border bg-card p-3 shadow-soft">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">{t('modifiers.library.title')}</p>
              <p className="text-xs text-muted-foreground">{t('modifiers.library.hint')}</p>
            </div>
            <IconButton
              type="button"
              size="sm"
              label={t('modifiers.library.close')}
              title={t('modifiers.library.close')}
              onClick={() => setLibraryOpen(false)}
              className="h-8 w-8 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </IconButton>
          </div>
          {library === null ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('modifiers.library.loading')}</p>
          ) : choices.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">
              {library.length === 0 ? t('modifiers.library.empty') : t('modifiers.library.allAdded')}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-border/60">
              {choices.map((row) => {
                // Names are the merchant's own words and go into the labels untouched.
                const name = row.name?.trim() || t('modifiers.library.unnamed');
                const optionCount = row.modifier_options?.length ?? 0;
                return (
                  <li key={row.id} className="flex items-center gap-2 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{name}</p>
                      <p className="text-xs text-muted-foreground">
                        {row.is_required ? t('modifiers.required') : t('modifiers.optional')}
                        {' · '}
                        {row.selection_type === 'multiple'
                          ? t('modifiers.library.pickUpTo', { max: row.max_select ?? 1 })
                          : t('modifiers.pickOne')}
                        {' · '}
                        {t('modifiers.library.optionCount', { count: optionCount })}
                      </p>
                    </div>
                    <Button
                      type="button"
                      variant="soft"
                      size="sm"
                      onClick={() => addFromLibrary(row)}
                      loading={addingFromLibrary === row.id}
                      disabled={addingFromLibrary !== null && addingFromLibrary !== row.id}
                      aria-label={t('modifiers.library.addNamed', { name })}
                      leftIcon={<Plus className="h-4 w-4" />}
                    >
                      {t('modifiers.library.add')}
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

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
              key={group.key}
              group={group}
              locked={lockedKeys.has(group.key)}
              canMoveUp={index > 0}
              canMoveDown={index < groups.length - 1}
              onMove={(dir) => moveGroup(group.id, dir)}
              onGroupChange={(patch) => updateGroup(group, patch)}
              onRemoveGroup={() => removeGroup(group)}
              onReset={() => resetGroup(group)}
              onOptionChange={(optId, patch) => updateOption(group, optId, patch)}
              onMoveOption={(optId, dir) => moveOption(group, optId, dir)}
              onToggleDefault={(optId) => toggleDefault(group, optId)}
              onRemoveOption={(optId) => removeOption(group, optId)}
              addingOption={addingOptionTo.has(group.key)}
              onAddOption={() => addOption(group)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

/** Where a group on this dish comes from, and the way back to the library version for a copy. */
function GroupSource({ group, onReset }: { group: MGroup; onReset: () => void }) {
  const t = useTranslations('menu');
  const kind = groupKind(group);
  if (kind === 'library') {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2.5 text-xs text-muted-foreground">
        <Badge variant="info">
          <Library className="h-3 w-3" aria-hidden />
          {t('modifiers.source.library')}
        </Badge>
        <span>{t('modifiers.source.libraryHint')}</span>
      </p>
    );
  }
  if (kind === 'copy') {
    return (
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2.5 text-xs">
        <Badge variant="warning">{t('modifiers.source.customized')}</Badge>
        <button
          type="button"
          onClick={onReset}
          className="focus-ring inline-flex items-center gap-1 rounded-lg px-1.5 py-0.5 font-semibold text-primary hover:bg-primary/10"
        >
          <Undo2 className="h-3.5 w-3.5" aria-hidden /> {t('modifiers.source.useLibrary')}
        </button>
      </div>
    );
  }
  return (
    <p className="px-3 pt-2.5 text-xs">
      <Badge variant="neutral">{t('modifiers.source.dishOnly')}</Badge>
    </p>
  );
}

function ModifierGroupCard({
  group: g,
  locked,
  canMoveUp,
  canMoveDown,
  onMove,
  onGroupChange,
  onRemoveGroup,
  onReset,
  onOptionChange,
  onMoveOption,
  onToggleDefault,
  onRemoveOption,
  addingOption,
  onAddOption,
}: {
  group: MGroup;
  /** A Remove or "Use the library version" is on its way: nothing in the card can be changed. */
  locked: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (dir: -1 | 1) => void;
  onGroupChange: (patch: GroupPatch) => void;
  onRemoveGroup: () => void;
  onReset: () => void;
  onOptionChange: (optId: string, patch: OptionPatch) => void;
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
    <div
      aria-busy={locked || undefined}
      className={cn(
        'overflow-hidden rounded-2xl border border-border bg-card shadow-soft transition-opacity',
        locked && 'opacity-60',
      )}
    >
      <fieldset disabled={locked} className="min-w-0">
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

        <GroupSource group={g} onReset={onReset} />

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
                key={opt.key}
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
                      onChange={(e) => onOptionChange(opt.id, { price_delta: e.target.value })}
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
      </fieldset>
    </div>
  );
}

/**
 * One side of a two-way switch. The side already picked does nothing: its click would rewrite the
 * group's rules (a required single group stored with no minimum gets one), and on a library group any
 * write makes the dish's own copy.
 */
function SegBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={active ? undefined : onClick}
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
