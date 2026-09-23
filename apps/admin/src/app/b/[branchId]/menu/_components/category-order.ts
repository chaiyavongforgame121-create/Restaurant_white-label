/**
 * The rules behind dragging categories into order, kept out of the component so they can be
 * tested on their own: what a drop does to the list, what the single renumbering statement is
 * sent, whether anything still needs writing, and how a list reloaded from the database is
 * merged with an arrangement the merchant has made but not saved yet.
 *
 * The whole branch is always renumbered in ONE `reorder_menu_categories` call. The triggers
 * added by 20260922120000 re-stamp every open order's line positions once per statement, so a
 * per-category update — or one call per drag — walks straight into the 8 s statement timeout
 * that migration was written to avoid.
 */

/** The little a category needs for ordering: enough for the tests to use plain objects. */
export interface OrderedCategory {
  id: string;
  displayOrder?: number | null;
}

/** The ids of a list, in the order it holds them. */
export function categoryIds(list: readonly { id: string }[]): string[] {
  return list.map((c) => c.id);
}

/**
 * The list after `activeId` is dropped where `overId` sits. The same array comes back when the
 * drop changed nothing (dropped on itself, or on a row that has since gone), so the caller can
 * tell a real move from a no-op without comparing the contents.
 */
export function moveCategory<T extends { id: string }>(
  list: readonly T[],
  activeId: string,
  overId: string,
): T[] {
  const from = list.findIndex((c) => c.id === activeId);
  const to = list.findIndex((c) => c.id === overId);
  if (from < 0 || to < 0 || from === to) return list as T[];
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}

/** The `p_orders` argument of `reorder_menu_categories`: the whole branch, renumbered from 0. */
export function categoryOrderPayload(
  list: readonly { id: string }[],
): Array<{ id: string; display_order: number }> {
  return list.map((c, index) => ({ id: c.id, display_order: index }));
}

/** Whether two id lists hold the same categories in the same order, so no write is needed. */
export function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((id, index) => id === b[index]);
}

/**
 * The list to show after a reload, when the merchant has dragged rows in this panel. The
 * arrangement on screen is kept for every category the database still has, and categories the
 * reload brought — one added here, or in another tab — go on the end, where their display_order
 * already puts them. Categories the reload no longer has simply fall out.
 *
 * Without this, renaming or deleting a category (both reload the list) would paint the database's
 * old order back over a drag that had not reached it yet.
 */
export function reconcileOrder<T extends { id: string }>(
  local: readonly T[],
  incoming: readonly T[],
): T[] {
  const byId = new Map(incoming.map((c) => [c.id, c]));
  const kept: T[] = [];
  for (const cat of local) {
    const fresh = byId.get(cat.id);
    // The reloaded row wins on everything but position: it carries the new name or icon.
    if (fresh) {
      kept.push(fresh);
      byId.delete(cat.id);
    }
  }
  for (const cat of incoming) {
    if (byId.has(cat.id)) kept.push(cat);
  }
  return kept;
}

/**
 * The display_order a newly added category takes so it lands last. It has to clear both the
 * positions on screen and whatever display_order values the branch still holds: a branch that has
 * never been dragged can sit on 1..7, while one renumbered by a drag sits on 0..6.
 */
export function nextDisplayOrder(list: readonly OrderedCategory[]): number {
  let max = list.length - 1;
  for (const cat of list) {
    const order = cat.displayOrder ?? 0;
    if (order > max) max = order;
  }
  return max + 1;
}
