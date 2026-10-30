import { compareByPosition } from '@favornoms/database/queries';

/**
 * The option groups of the dish editor (item-modifier-editor.tsx), kept apart from React and
 * Supabase so the rules can be tested on their own (item-modifier-model.test.ts).
 *
 * A dish shows two kinds of option group (migration 20261030100000_item_modifier_copies.sql):
 * - a LIBRARY group, made on the Modifier groups page (owner_menu_item_id null), shown on the dish as
 *   it is there and shared with every other dish that shows it;
 * - the dish's OWN group (owner_menu_item_id = the dish), which that page never lists: its copy of a
 *   library group (source_group_id = that group), or a group made in the dish's editor.
 * Nothing the dish editor does is written to a library group. The first change made to one there
 * gives the dish its own copy (customize_item_modifier_group), the dish shows the copy where it
 * showed the library group, and the change goes to the copy: the library group and every other dish
 * keep theirs. Asked for by the owner on 2026-10-30, after deleting two options of Spicy Level inside
 * one dish took them off the Modifier groups page and off every dish showing the group.
 */

export interface MOption {
  /** A database id, or a temporary one (tmp_…) on a dish that is not saved yet. */
  id: string;
  /**
   * React's key. Kept when the id changes (the dish's copy arriving, a picked group turned into a
   * draft copy), so the row and the field being typed in stay mounted and keep the focus.
   */
  key: string;
  name: string;
  price_delta: number | string;
  is_default: boolean;
  is_active: boolean;
  display_order: number;
  /** Breaks position ties the way the storefront does; absent on a draft option. */
  created_at?: string | null;
}

export interface MGroup {
  id: string;
  /** React's key; see MOption.key. */
  key: string;
  name: string;
  selection_type: 'single' | 'multiple';
  is_required: boolean;
  min_select: number;
  max_select: number;
  /** Position on this dish (menu_item_modifiers.display_order). */
  display_order: number;
  options: MOption[];
  /**
   * The group belongs to this dish only (owner_menu_item_id = the dish, or made in the editor of a
   * dish not saved yet). False: a library group, shown as it is on the Modifier groups page.
   */
  own: boolean;
  /** The library group this dish's own group was copied from; null for a library group and for one made here. */
  sourceGroupId: string | null;
}

/** The fields of a group the editor changes. */
export type GroupPatch = Partial<Pick<MGroup, 'name' | 'selection_type' | 'is_required' | 'min_select' | 'max_select'>>;
/** The fields of an option the editor changes. */
export type OptionPatch = Partial<Pick<MOption, 'name' | 'price_delta' | 'is_default' | 'is_active'>>;

/**
 * `patch` without the fields `row` already holds. A click that changes nothing (the segment already
 * picked, "−" at its minimum) then writes nothing: on a library group it would give the dish its own
 * copy, and the changes made on the Modifier groups page afterwards would stop reaching the dish.
 */
export function changedFields<T extends object, P extends Partial<T>>(row: T, patch: P): Partial<P> {
  const changed: Partial<P> = {};
  for (const key of Object.keys(patch) as (keyof P & keyof T)[]) {
    const value: unknown = patch[key];
    if (value !== row[key]) changed[key] = patch[key];
  }
  return changed;
}

/** What a group on the dish is: from the library as it is, the dish's copy of one, or made for the dish. */
export type GroupKind = 'library' | 'copy' | 'dishOnly';

export function groupKind(group: Pick<MGroup, 'own' | 'sourceGroupId'>): GroupKind {
  if (!group.own) return 'library';
  return group.sourceGroupId ? 'copy' : 'dishOnly';
}

// ── Reading ────────────────────────────────────────────────────────────────────────────────────

export interface OptionRow {
  id: string;
  name: string | null;
  price_delta: number | string;
  is_default: boolean | null;
  is_active: boolean | null;
  display_order: number | null;
  created_at?: string | null;
}

/** A modifier_groups row with its options, as the editor reads it. */
export interface GroupRow {
  id: string;
  name: string | null;
  selection_type: string | null;
  is_required: boolean | null;
  min_select: number | null;
  max_select: number | null;
  display_order: number | null;
  created_at?: string | null;
  owner_menu_item_id?: string | null;
  source_group_id?: string | null;
  modifier_options?: readonly OptionRow[] | null;
}

/** A menu_item_modifiers row with its group embedded. */
export interface LinkRow {
  display_order: number | null;
  modifier_groups: GroupRow | readonly GroupRow[] | null;
}

/**
 * A group as the editor shows it, at `position` on the dish. `itemId` is the dish being edited (null
 * while it is not saved yet): only a group it owns is its own.
 */
export function groupFromRow(row: GroupRow, position: number, itemId: string | null): MGroup {
  const own = !!itemId && row.owner_menu_item_id === itemId;
  return {
    id: row.id,
    key: row.id,
    name: row.name ?? '',
    selection_type: row.selection_type === 'multiple' ? 'multiple' : 'single',
    is_required: !!row.is_required,
    min_select: row.min_select ?? 0,
    max_select: row.max_select ?? 1,
    display_order: position,
    options: (row.modifier_options ?? [])
      .slice()
      .sort(compareByPosition)
      .map((o) => ({
        id: o.id,
        key: o.id,
        name: o.name ?? '',
        price_delta: o.price_delta,
        is_default: !!o.is_default,
        is_active: !!o.is_active,
        display_order: o.display_order ?? 0,
        created_at: o.created_at ?? null,
      })),
    own,
    sourceGroupId: own ? (row.source_group_id ?? null) : null,
  };
}

/** A dish's links as its editor lists them: the storefront's order (position on the dish, then the group's own). */
export function groupsFromLinks(links: readonly LinkRow[], itemId: string): MGroup[] {
  const entries: { group: MGroup; link: number; row: GroupRow }[] = [];
  for (const link of links) {
    const row = Array.isArray(link.modifier_groups)
      ? (link.modifier_groups as readonly GroupRow[])[0]
      : (link.modifier_groups as GroupRow | null);
    if (!row) continue;
    entries.push({
      group: groupFromRow(row, link.display_order ?? row.display_order ?? 0, itemId),
      link: link.display_order ?? 0,
      row,
    });
  }
  entries.sort((a, b) => a.link - b.link || compareByPosition(a.row, b.row));
  return entries.map((entry) => entry.group);
}

/** `next` keyed like `current`, matched by id; a row new to the screen is keyed by its id, never a key in use. */
function carryKeys<T extends { id: string; key: string }>(
  next: readonly T[],
  current: readonly T[],
  each: (row: T, was: T | undefined) => T,
): T[] {
  const byId = new Map(current.map((row) => [row.id, row]));
  const used = new Set<string>();
  for (const row of next) {
    const was = byId.get(row.id);
    if (was) used.add(was.key);
  }
  return next.map((row) => {
    const was = byId.get(row.id);
    let key = was?.key;
    if (key === undefined) {
      // A copy keeps its library group's id as its key, so an id can already be a key in use.
      key = row.id;
      while (used.has(key)) key = `${key}'`;
      used.add(key);
    }
    const out = each(row, was);
    return out.key === key ? out : { ...out, key };
  });
}

/**
 * A fresh read keyed like the rows on screen, so that reading the list back keeps every card and
 * field mounted, and the focus where it is. The rows of a copy made during this visit keep the keys
 * their library group had.
 */
export function keepKeys(next: readonly MGroup[], current: readonly MGroup[]): MGroup[] {
  return carryKeys(next, current, (group, was) => {
    if (!was) return group;
    const options = carryKeys(group.options, was.options, (option) => option);
    return options.every((option, i) => option === group.options[i]) ? group : { ...group, options };
  });
}

// ── The dish's copy of a library group ──────────────────────────────────────────────────────────

/** customize_item_modifier_group's answer. */
export interface GroupCopy {
  /** The dish's own group the change goes to: the new copy, or the group itself when it already was. */
  groupId: string;
  /** False when the group already was the dish's own and nothing was copied. */
  copied: boolean;
  /** The library group it was copied from. */
  sourceGroupId: string | null;
  /** Library option id → the copy's id for it; every option of the group, even hidden ones. */
  options: ReadonlyMap<string, string>;
}

/** The RPC's jsonb answer, or null when it is not in the agreed shape. */
export function parseGroupCopy(data: unknown): GroupCopy | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const answer = data as Record<string, unknown>;
  if (typeof answer.group_id !== 'string' || !answer.group_id) return null;
  const options = new Map<string, string>();
  if (answer.options != null) {
    if (typeof answer.options !== 'object' || Array.isArray(answer.options)) return null;
    for (const [from, to] of Object.entries(answer.options as Record<string, unknown>)) {
      if (typeof to !== 'string' || !to) return null;
      options.set(from, to);
    }
  }
  return {
    groupId: answer.group_id,
    copied: answer.copied === true,
    sourceGroupId: typeof answer.source_group_id === 'string' ? answer.source_group_id : null,
    options,
  };
}

/** reset_item_modifier_group's answer: the library group the dish shows again, or null when not in the agreed shape. */
export function parseResetAnswer(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const groupId = (data as Record<string, unknown>).group_id;
  return typeof groupId === 'string' && groupId ? groupId : null;
}

/**
 * The screen once the dish's copy of group `fromId` exists: the same card with the copy's ids, marked
 * the dish's own. Only ids change, so whatever was typed while the copy was being made stays, and the
 * keys stay, so nothing is remounted or loses the focus.
 */
export function showCopy(groups: readonly MGroup[], fromId: string, copy: GroupCopy): MGroup[] {
  return groups.map((g) => {
    if (g.id !== fromId) return g;
    return {
      ...g,
      id: copy.groupId,
      own: true,
      sourceGroupId: copy.sourceGroupId,
      options: g.options.map((o) => {
        const id = copy.options.get(o.id);
        return id && id !== o.id ? { ...o, id } : o;
      }),
    };
  });
}

export interface WriteTarget {
  /** The group's id on the dish now: the dish's copy once it exists. */
  groupId: string;
  /** That group is the dish's own. False only for a library group, in a task run with `copy: false`. */
  own: boolean;
  /** An option's id now: the copy's, for an option of the library group it was copied from. */
  optionId: (id: string) => string;
}

export interface WriteResult {
  error: unknown;
}

export interface GroupWritesHooks {
  /** Makes the dish's copy of a library group (customize_item_modifier_group); rejects with the failure. */
  copy: (groupId: string) => Promise<GroupCopy>;
  /** The copy exists: show it (showCopy). Runs before any write lands on it. */
  onCopied: (fromId: string, copy: GroupCopy) => void;
  /** The copy failed, so nothing was stored. Runs once per failure, whatever was waiting for it. */
  onCopyFailed: (fromId: string, error: unknown) => void;
  /** A task settled (stored, refused or dropped); `pending` and `settled` already count it. */
  onSettled?: () => void;
}

const sameId = (id: string) => id;

/**
 * A saved dish's writes to its option groups: one queue per group, and the copy made on the first
 * change to a library group.
 *
 * Each keystroke is written as it is typed, so ten writes can need the same group's copy at once.
 * The queue runs a group's writes one after another, in the order they were made, so they never race
 * each other; the first that needs the copy makes it (one call per library group, however many
 * writes ask), and the rest land on the copy's ids. The copy keeps its library group's queue, so a
 * write made once the copy is on screen still lands after the ones made before. When the copy fails
 * nothing was stored: the writes waiting for it are dropped (resolved null; the caller reads the list
 * back) and the next change tries again.
 *
 * `pending` and `settled` tell a reader whether the screen holds changes the database does not have
 * yet: a read applied while a write is queued (behind a copy, say) would put the old value back over
 * what was typed, and the next keystroke would then save the old value too.
 *
 * The dish's group order is saved across every group at once (exclusive): it names each group by its
 * id on the dish, so nothing may move a link to another id between reading those ids and the order
 * being stored.
 */
export class GroupWrites {
  /** Library group id → the dish's copy of it. */
  private readonly copies = new Map<string, GroupCopy>();
  /** A copy's id → the library group whose queue it keeps. */
  private readonly origins = new Map<string, string>();
  /** A copy the dish went back from ("Use the library version") → that library group. */
  private readonly restored = new Map<string, string>();
  /** Library option id → the copy's option id, across every copy. */
  private readonly optionIds = new Map<string, string>();
  private readonly copying = new Map<string, Promise<GroupCopy>>();
  private readonly tails = new Map<string, Promise<unknown>>();
  /** Settles once no exclusive task is out: every task queued meanwhile, in any group, waits for it. */
  private barrier: Promise<unknown> = Promise.resolve();
  /** Bumped when a group's copy fails: the writes queued before then were waiting for it. */
  private readonly epochs = new Map<string, number>();
  private queued = 0;
  private done = 0;

  constructor(private readonly hooks: GroupWritesHooks) {}

  /** Tasks queued and not settled yet. */
  get pending(): number {
    return this.queued;
  }

  /** Tasks settled so far: a read sent before this moved may predate a write. */
  get settled(): number {
    return this.done;
  }

  /**
   * A group's id on the dish now: its copy's id once the copy exists, and for a copy the dish went
   * back from, its library group's (or that group's next copy's).
   */
  groupId(id: string): string {
    const base = this.restored.get(id) ?? id;
    return this.copies.get(base)?.groupId ?? base;
  }

  /** An option's id on the dish now: its copy's id once the group's copy exists. */
  optionId(id: string): string {
    return this.optionIds.get(id) ?? id;
  }

  /**
   * Runs `task` after every task already queued for this group (and after an exclusive task that is
   * out). With `copy`, the task gets the dish's own group, copying a library group first; without, it
   * gets the group as the dish shows it now (Remove, "Use the library version"). Resolves with the
   * task's result, or null when the copy it needed failed. A task that throws resolves with the thrown
   * value as its error.
   */
  run(
    group: { id: string; own: boolean },
    task: (to: WriteTarget) => PromiseLike<WriteResult>,
    { copy }: { copy: boolean },
  ): Promise<WriteResult | null> {
    const queue = this.origins.get(group.id) ?? group.id;
    const epoch = this.epochs.get(queue) ?? 0;
    this.queued += 1;
    const result = Promise.all([this.tails.get(queue), this.barrier]).then(async (): Promise<WriteResult | null> => {
      try {
        if (copy && (this.epochs.get(queue) ?? 0) !== epoch) return null;
        let to: WriteTarget;
        const made = this.copies.get(queue);
        if (made) {
          to = { groupId: made.groupId, own: true, optionId: (id) => made.options.get(id) ?? id };
        } else if (group.own) {
          to = { groupId: group.id, own: true, optionId: sameId };
        } else if (!copy) {
          to = { groupId: group.id, own: false, optionId: sameId };
        } else {
          let fresh: GroupCopy;
          try {
            fresh = await this.copyOnce(queue);
          } catch (error) {
            this.epochs.set(queue, (this.epochs.get(queue) ?? 0) + 1);
            this.hooks.onCopyFailed(queue, error);
            return null;
          }
          to = { groupId: fresh.groupId, own: true, optionId: (id) => fresh.options.get(id) ?? id };
        }
        try {
          return await task(to);
        } catch (error) {
          return { error: error ?? new Error('write failed') };
        }
      } finally {
        // Counted before the caller hears back, so a read it sends next is not held for this task.
        this.queued -= 1;
        this.done += 1;
        this.hooks.onSettled?.();
      }
    });
    this.tails.set(
      queue,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }

  /** Resolves once every task queued so far has settled. */
  idle(): Promise<void> {
    return Promise.all([...this.tails.values()]).then(() => undefined);
  }

  /**
   * Runs `task` once every task queued so far (and an exclusive task still out) has settled, and holds
   * every task queued while it is out, in any group, until it has. For the dish's group order: a copy
   * made or a "Use the library version" landing between reading the ids and the order being stored
   * would move a link to an id the order does not name, and that group would go last.
   */
  async exclusive<T>(task: () => PromiseLike<T>): Promise<T> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const before = Promise.all([this.idle(), this.barrier]);
    this.barrier = Promise.all([this.barrier, gate]);
    try {
      await before;
      return await task();
    } finally {
      release();
    }
  }

  /**
   * The dish went back to library group `libraryId` (reset_item_modifier_group): the copy's id now
   * names that group, and its next change copies it again.
   */
  forget(groupId: string, libraryId: string): void {
    // Also for a copy made on an earlier visit, which this queue never saw being made.
    this.restored.set(groupId, libraryId);
    const queue = this.origins.get(groupId) ?? groupId;
    const made = this.copies.get(queue);
    if (!made) return;
    this.copies.delete(queue);
    this.origins.delete(made.groupId);
    for (const [from, to] of made.options) {
      if (this.optionIds.get(from) === to) this.optionIds.delete(from);
    }
  }

  private copyOnce(groupId: string): Promise<GroupCopy> {
    let pending = this.copying.get(groupId);
    if (!pending) {
      pending = this.hooks.copy(groupId).then((made) => {
        this.copies.set(groupId, made);
        if (made.groupId !== groupId) this.origins.set(made.groupId, groupId);
        for (const [from, to] of made.options) if (from !== to) this.optionIds.set(from, to);
        this.hooks.onCopied(groupId, made);
        return made;
      });
      const settled = () => {
        this.copying.delete(groupId);
      };
      pending.then(settled, settled);
      this.copying.set(groupId, pending);
    }
    return pending;
  }
}

// ── A dish that is not saved yet ────────────────────────────────────────────────────────────────

/**
 * A change to group `groupId` on a dish that is not saved yet, where every edit stays on screen until
 * the dish is saved. A library group picked from Modifier groups becomes the dish's own copy first:
 * new temporary ids, `sourceGroupId` naming the library group (which is never changed), and the same
 * keys, so nothing loses the focus. `change` gets a test for "is this row the option the event named",
 * since the copy's options have new ids.
 */
export function changeDraftGroup(
  groups: readonly MGroup[],
  groupId: string,
  mintId: () => string,
  change: (group: MGroup, sameOption: (rowId: string, eventId: string) => boolean) => MGroup,
): MGroup[] {
  return groups.map((g) => {
    if (g.id !== groupId) return g;
    if (g.own) return change(g, (rowId, eventId) => rowId === eventId);
    const ids = new Map(g.options.map((o) => [o.id, mintId()]));
    const copy: MGroup = {
      ...g,
      id: mintId(),
      own: true,
      sourceGroupId: g.id,
      options: g.options.map((o) => ({ ...o, id: ids.get(o.id) ?? o.id })),
    };
    return change(copy, (rowId, eventId) => rowId === (ids.get(eventId) ?? eventId));
  });
}

/** The first reason a new dish's option groups cannot be saved yet, for menu.modifiers.validation. */
export type DraftProblem = { key: 'groupName' } | { key: 'noOptions' | 'blankOptions'; group: string };

/**
 * Blocks the save while a group of the dish's own is half-built, so a blank-named or optionless group
 * never ships: a Required group with no options dead-ends the cart, and unnamed controls are broken on
 * the customer menu. A completely empty one (no name, no options) is dropped on save instead. A
 * library group goes on the dish as it is on the Modifier groups page, which is where it is edited.
 */
export function draftProblem(groups: readonly MGroup[]): DraftProblem | null {
  for (const g of groups) {
    if (!g.own) continue;
    const name = g.name.trim();
    if (!name && g.options.length === 0) continue;
    if (!name) return { key: 'groupName' };
    if (!g.options.some((o) => String(o.name).trim())) return { key: 'noOptions', group: name };
    if (g.options.some((o) => !String(o.name).trim())) return { key: 'blankOptions', group: name };
  }
  return null;
}

export type DraftStep =
  /** A library group left as it is: the dish shows the library group itself. */
  | { kind: 'link'; groupId: string; name: string; position: number }
  /** A group of the dish's own: made here, or a picked library group changed here (sourceGroupId). */
  | {
      kind: 'own';
      position: number;
      sourceGroupId: string | null;
      group: {
        name: string;
        selection_type: 'single' | 'multiple';
        is_required: boolean;
        min_select: number;
        max_select: number;
      };
      options: {
        name: string;
        price_delta: number;
        is_default: boolean;
        is_active: boolean;
        display_order: number;
      }[];
    };

/**
 * What saving a new dish writes for its option groups, in the order on screen. The dish's own groups
 * lose the noise a draft collects (names trimmed, blank-named options dropped, a group left completely
 * empty dropped: "Add group" clicked, then nothing); positions are numbered 0..n-1 over what is left.
 */
export function draftSteps(groups: readonly MGroup[]): DraftStep[] {
  const steps: DraftStep[] = [];
  for (const g of groups) {
    if (!g.own) {
      steps.push({ kind: 'link', groupId: g.id, name: g.name.trim(), position: steps.length });
      continue;
    }
    const name = g.name.trim();
    const options = g.options
      .filter((o) => String(o.name).trim())
      .map((o, index) => ({
        name: String(o.name).trim(),
        price_delta: Number(o.price_delta) || 0,
        is_default: o.is_default,
        is_active: o.is_active,
        display_order: index,
      }));
    if (!name && options.length === 0) continue;
    steps.push({
      kind: 'own',
      position: steps.length,
      sourceGroupId: g.sourceGroupId,
      group: {
        name,
        selection_type: g.selection_type,
        is_required: g.is_required,
        min_select: g.min_select,
        max_select: g.max_select,
      },
      options,
    });
  }
  return steps;
}

// ── "Add from Modifier groups" ─────────────────────────────────────────────────────────────────

/**
 * The library groups "Add from Modifier groups" offers the dish, in the library's order: not on the
 * dish already, as they are or as the dish's copy (the dish would show the group twice).
 */
export function libraryChoices<T extends GroupRow>(
  library: readonly T[],
  onDish: readonly Pick<MGroup, 'id' | 'sourceGroupId'>[],
): T[] {
  const taken = new Set<string>();
  for (const g of onDish) {
    taken.add(g.id);
    if (g.sourceGroupId) taken.add(g.sourceGroupId);
  }
  return library.filter((row) => !row.owner_menu_item_id && !taken.has(row.id)).sort(compareByPosition);
}

// ── Failures ──────────────────────────────────────────────────────────────────────────────────

function messageOf(err: unknown): string {
  if (typeof err === 'string') return err;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return '';
}

function codeOf(err: unknown): string {
  const code = err && typeof err === 'object' ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : '';
}

/**
 * Refusals of customize_item_modifier_group and reset_item_modifier_group that have their own sentence
 * under menu.modifiers.copyErrors, or null for any other failure (menuErrorKey translates those):
 * - listChanged: the group is not what this screen shows (the dish no longer shows it, it is not a copy
 *   any more, or it is another dish's own), so the list is read back;
 * - sourceMissing: the library group a copy was made from is no longer in the branch's library.
 */
export type CopyErrorKey = 'listChanged' | 'sourceMissing';

export function copyErrorKey(err: unknown): CopyErrorKey | null {
  const message = messageOf(err);
  if (/modifier_link_not_found|modifier_group_not_customized|modifier_group_owned_elsewhere/.test(message)) {
    return 'listChanged';
  }
  if (message.includes('modifier_source_missing')) return 'sourceMissing';
  return null;
}

/**
 * Saving a new dish's copy of a picked library group was refused over its source: the library group was
 * deleted since it was picked (the foreign key), or is no longer a library group of the branch
 * (modifier_source_invalid). The copy is then saved without a source, as a group made for the dish.
 */
export function isSourceRefusal(err: unknown): boolean {
  const message = messageOf(err);
  return (
    message.includes('modifier_source_invalid') || (codeOf(err) === '23503' && message.includes('source_group_id'))
  );
}

/** A link to an option group that no longer exists (deleted from Modifier groups since it was listed). */
export function isGroupGone(err: unknown): boolean {
  return codeOf(err) === '23503' && messageOf(err).includes('menu_item_modifiers_modifier_group_id_fkey');
}
