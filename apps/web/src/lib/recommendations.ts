import type { MenuItem } from '@favornoms/shared';

export interface RecommendationRow {
  menu_item_id: string;
  item_name: string;
  image_url: string | null;
  price: number;
}

export interface ResolvedRecommendation {
  rec: RecommendationRow;
  target: MenuItem;
}

/**
 * Pair each recommendation with the full MenuItem it refers to. The RPC row carries only
 * a name, photo and raw price — not the branch, stock flag or happy-hour price the sheet
 * and cart need — so the loaded menu is the source of truth. Rows that do not resolve
 * (inactive item, another branch) and the item already open are dropped: a card the diner
 * cannot open or add is noise, not a recommendation.
 */
export function resolveRecommendations(
  rows: RecommendationRow[],
  items: MenuItem[],
  currentItemId: string | undefined,
): ResolvedRecommendation[] {
  const byId = new Map(items.map((i) => [i.id, i] as const));
  const seen = new Set<string>();
  const out: ResolvedRecommendation[] = [];
  for (const rec of rows) {
    if (rec.menu_item_id === currentItemId || seen.has(rec.menu_item_id)) continue;
    const target = byId.get(rec.menu_item_id);
    if (!target) continue;
    seen.add(rec.menu_item_id);
    out.push({ rec, target });
  }
  return out;
}
