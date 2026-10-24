import type { Database } from '../types';
import type { FavornomsClient } from '../client-type';

type RowStation = Database['public']['Tables']['kitchen_stations']['Row'];

/**
 * One of a branch's kitchen stations (docs/KITCHEN-STATIONS-2026-10-24.md). `key` is what
 * menu_items.station, order_items.station, a combo line's snapshot and the kitchen board's
 * `?station=` hold; it never changes, so a rename touches no dish and no order line.
 */
export interface KitchenStation {
  id: string;
  branchId: string;
  /** hot, cold, bar, dessert or expo for the built-ins; st_ and 10 hex characters for the rest. */
  key: string;
  /** The merchant's name. Null only on a built-in that was never renamed: show its translation. */
  name: string | null;
  displayOrder: number;
}

const STATION_COLUMNS = 'id, branch_id, key, name, display_order';

/**
 * The branch's stations in the order the merchant arranged them. Two saved at the same position
 * fall back to key, then id: the same tie-break as the back office's sortStations, so the menu
 * page, the stations sheet and the kitchen pills list them alike.
 */
export async function listKitchenStations(
  supabase: FavornomsClient,
  branchId: string,
): Promise<KitchenStation[]> {
  const { data, error } = await supabase
    .from('kitchen_stations')
    .select(STATION_COLUMNS)
    .eq('branch_id', branchId)
    .order('display_order', { ascending: true })
    .order('key', { ascending: true })
    .order('id', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapStation);
}

/**
 * Adds a station after the branch's last one. The database mints the key (the API roles hold no
 * privilege on that column) and trims the name; a blank name, one over 40 characters (23514) or
 * one the branch already uses, ignoring case (23505), is refused there.
 */
export async function createKitchenStation(
  supabase: FavornomsClient,
  branchId: string,
  name: string,
): Promise<KitchenStation> {
  // In steps of ten, as the built-ins start and reorder_kitchen_stations renumbers.
  const { data: last, error: lastError } = await supabase
    .from('kitchen_stations')
    .select('display_order')
    .eq('branch_id', branchId)
    .order('display_order', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (lastError) throw lastError;

  const { data, error } = await supabase
    .from('kitchen_stations')
    .insert({ branch_id: branchId, name: name.trim(), display_order: (last?.display_order ?? 0) + 10 })
    .select(STATION_COLUMNS)
    .single();

  if (error) throw error;
  return mapStation(data);
}

/**
 * Renames a station. Null or a blank name takes a built-in back to its translated label; any other
 * station must keep a name, and the database refuses the change (23514). Throws
 * `station_not_found` (code P0002) when no row changed: row-level security hides a station the
 * caller may not edit, and one deleted meanwhile is gone.
 */
export async function renameKitchenStation(
  supabase: FavornomsClient,
  id: string,
  name: string | null,
): Promise<KitchenStation> {
  const trimmed = name?.trim() ?? '';
  const { data, error } = await supabase
    .from('kitchen_stations')
    .update({ name: trimmed === '' ? null : trimmed })
    .eq('id', id)
    .select(STATION_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  // The returned row is the proof the rename happened; an update RLS filtered out reports no error.
  if (!data) throw Object.assign(new Error('station_not_found'), { code: 'P0002' });
  return mapStation(data);
}

/**
 * Deletes a station through public.delete_kitchen_station. Its dishes move to `moveTo`, another
 * station key of the same branch, or to no station when `moveTo` is null and `clear` is set; their
 * lines on open kitchen boards (made or not) and combo entries naming it move with them, while
 * closed orders keep the old key. Without `moveTo` or `clear`, a station still on a dish is
 * refused with station_in_use: a list that showed it unused may be stale, so "No station" is sent
 * only when the merchant chose it. `clear` changes nothing when `moveTo` is given.
 * Answers how many dishes moved. A refusal is the error's message: forbidden, station_not_found,
 * move_target_invalid or station_in_use.
 */
export async function deleteKitchenStation(
  supabase: FavornomsClient,
  id: string,
  moveTo: string | null,
  options: { clear?: boolean } = {},
): Promise<number> {
  const { data, error } = await supabase.rpc('delete_kitchen_station', {
    p_station_id: id,
    // Left out for "no station": the parameter's default is null.
    ...(moveTo ? { p_move_to: moveTo } : {}),
    // Left out unless asked for: the parameter's default is false.
    ...(options.clear ? { p_clear: true } : {}),
  });

  if (error) throw error;
  return Number(data ?? 0);
}

/**
 * Puts the branch's stations in the order of `ids`, which must name every station of the branch
 * once; a list from before a station was added or deleted is refused with ids_mismatch.
 */
export async function reorderKitchenStations(
  supabase: FavornomsClient,
  branchId: string,
  ids: string[],
): Promise<void> {
  const { error } = await supabase.rpc('reorder_kitchen_stations', {
    p_branch_id: branchId,
    p_ids: ids,
  });

  if (error) throw error;
}

function mapStation(row: Partial<RowStation>): KitchenStation {
  return {
    id: row.id!,
    branchId: row.branch_id!,
    key: row.key!,
    name: row.name ?? null,
    displayOrder: row.display_order ?? 0,
  };
}
