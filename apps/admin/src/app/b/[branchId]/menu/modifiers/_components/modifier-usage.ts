/**
 * How the dishes of a branch use one library option group, kept out of the Modifier groups page
 * so it can be tested on its own.
 *
 * A dish shows a library group as is (a plain menu_item_modifiers link to it), or through its own
 * copy: the first change made to a library group in a dish's editor copies the group onto that
 * dish (customize_item_modifier_group, 20261030100000) and moves the dish's link over to the copy.
 * The copy belongs to the dish (owner_menu_item_id), remembers the library group it was made from
 * (source_group_id) and never appears in the library. So an edit made on this page reaches every
 * dish that links the group, and none of the dishes that carry a copy of it.
 */

/** One group on a dish, as the page reads it. */
export interface GroupLink {
  modifier_group_id: string;
  /**
   * The linked group's source_group_id, set when the group is the dish's own copy of a library
   * group. A many-to-one embed arrives as one object, although the generated types may call it an
   * array, so both are read.
   */
  modifier_groups?: { source_group_id: string | null } | Array<{ source_group_id: string | null }> | null;
}

/** The little a dish needs here: enough for the tests to use plain objects. */
export interface LinkedItem {
  id: string;
  menu_item_modifiers?: readonly GroupLink[] | null;
}

/** The library group a linked group was copied from: null for a library group, or one made on the dish. */
export function copiedFrom(link: GroupLink): string | null {
  const group = Array.isArray(link.modifier_groups) ? link.modifier_groups[0] : link.modifier_groups;
  return group?.source_group_id ?? null;
}

/**
 * The dishes that show the library group as is, and the dishes that carry their own copy of it,
 * each in the order given. "Linked to N items" counts the first list only.
 */
export function groupUsage<T extends LinkedItem>(
  items: readonly T[],
  groupId: string,
): { linked: T[]; customized: T[] } {
  const linked: T[] = [];
  const customized: T[] = [];
  for (const item of items) {
    const links = item.menu_item_modifiers ?? [];
    if (links.some((l) => l.modifier_group_id === groupId)) linked.push(item);
    if (links.some((l) => copiedFrom(l) === groupId)) customized.push(item);
  }
  return { linked, customized };
}

/**
 * What Save links writes for the dishes ticked in the picker: a ticked dish without the group gets
 * it, an unticked dish that has it loses it. A dish that carries its own copy is never linked or
 * unlinked, whatever its box says: linking it would put the library group and the copy on one dish,
 * and the copy stays the dish's until "Use the library version" in its editor swaps the library
 * group back in.
 */
export function linkChanges(
  items: readonly LinkedItem[],
  groupId: string,
  ticked: ReadonlySet<string>,
): { toAdd: string[]; toRemove: string[] } {
  const { linked, customized } = groupUsage(items, groupId);
  const linkedIds = new Set(linked.map((m) => m.id));
  const leftAlone = new Set(customized.map((m) => m.id));
  return {
    toAdd: Array.from(ticked).filter((id) => !linkedIds.has(id) && !leftAlone.has(id)),
    toRemove: linked.map((m) => m.id).filter((id) => !ticked.has(id) && !leftAlone.has(id)),
  };
}

/**
 * The dishes of `ids` that can still be given the group, by a read of the branch made just before
 * the insert. The picker shows the page as it was loaded: a dish that has since got the group (in
 * another tab) would fail the whole insert on the link's primary key, and one that has since got
 * its own copy would end up with both versions. A dish the read does not show is kept, as before:
 * the insert decides.
 */
export function stillLinkable(fresh: readonly LinkedItem[], groupId: string, ids: readonly string[]): string[] {
  const { linked, customized } = groupUsage(fresh, groupId);
  const taken = new Set([...linked, ...customized].map((m) => m.id));
  return ids.filter((id) => !taken.has(id));
}

/** Up to `max` names for a sentence, and how many more there are. */
export function namePreview(items: readonly { name: string }[], max = 3): { names: string; more: number } {
  return {
    names: items
      .slice(0, max)
      .map((m) => m.name)
      .join(', '),
    more: Math.max(0, items.length - max),
  };
}
