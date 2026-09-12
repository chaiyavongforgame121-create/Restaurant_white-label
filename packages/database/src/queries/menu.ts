import type {
  DietaryTag,
  LocalizedText,
  MenuCategory,
  MenuItem,
  ModifierGroup,
} from '@favornoms/shared';
import type { Database } from '../types';
import type { FavornomsClient } from '../client-type';

type RowCat = Database['public']['Tables']['menu_categories']['Row'];
type RowItem = Database['public']['Tables']['menu_items']['Row'];

/** Fetch all active categories for a branch, ordered. */
export async function listCategories(
  supabase: FavornomsClient,
  branchId: string,
): Promise<MenuCategory[]> {
  const { data, error } = await supabase
    .from('menu_categories')
    .select('id, branch_id, name, name_translations, display_order, icon_emoji, is_active')
    .eq('branch_id', branchId)
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapCategory);
}

/** Fetch all active menu items for a branch. */
export async function listMenuItems(
  supabase: FavornomsClient,
  branchId: string,
): Promise<MenuItem[]> {
  const { data, error } = await supabase
    .from('menu_items')
    .select(
      `
      id, branch_id, category_id, name, name_translations,
      description, description_translations, price, image_url,
      is_recommended, is_new, dietary_tags, allergens, rating, review_count,
      prep_time_minutes, calories, display_order, track_stock, stock_quantity
    `,
    )
    .eq('branch_id', branchId)
    .eq('is_active', true)
    .order('display_order', { ascending: true });

  if (error) throw error;
  return (data ?? []).map(mapItem);
}

/** Single item — for the detail sheet, if you want SSR-fetched data. */
export async function getMenuItem(
  supabase: FavornomsClient,
  itemId: string,
): Promise<MenuItem | null> {
  const { data, error } = await supabase
    .from('menu_items')
    .select(
      `
      id, branch_id, category_id, name, name_translations,
      description, description_translations, price, image_url,
      is_recommended, is_new, dietary_tags, allergens, rating, review_count,
      prep_time_minutes, calories, display_order, track_stock, stock_quantity
    `,
    )
    .eq('id', itemId)
    .eq('is_active', true)
    .maybeSingle();

  if (error) throw error;
  return data ? mapItem(data) : null;
}

// ---------- Mappers ----------

function mapCategory(row: Partial<RowCat>): MenuCategory {
  return {
    id: row.id!,
    branchId: row.branch_id!,
    name: row.name!,
    nameTranslations: (row.name_translations ?? {}) as LocalizedText,
    displayOrder: row.display_order ?? 0,
    iconEmoji: row.icon_emoji ?? undefined,
  };
}

function mapItem(row: Partial<RowItem>): MenuItem {
  return {
    id: row.id!,
    branchId: row.branch_id!,
    categoryId: row.category_id!,
    name: row.name!,
    nameTranslations: (row.name_translations ?? {}) as LocalizedText,
    description: row.description ?? undefined,
    descriptionTranslations: (row.description_translations ?? {}) as LocalizedText,
    price: Number(row.price ?? 0),
    imageUrl: row.image_url ?? null,
    isRecommended: row.is_recommended ?? false,
    isNew: row.is_new ?? false,
    dietaryTags: ((row.dietary_tags ?? []) as string[]) as DietaryTag[],
    allergens: (row.allergens ?? []) as string[],
    rating: row.rating != null ? Number(row.rating) : undefined,
    reviewCount: row.review_count ?? 0,
    prepTimeMinutes: row.prep_time_minutes ?? undefined,
    calories: row.calories ?? undefined,
    outOfStock: row.track_stock === true && (row.stock_quantity ?? 0) <= 0,
  };
}


/**
 * The option groups attached to one menu item, ordered, with dead options dropped.
 *
 * Shared rather than inlined at the call site: the storefront's item sheet and the
 * counter's both ask this question, and a till that reads the groups differently from the
 * phone at the table is a till that prices the same burger differently. `price_delta` is a
 * postgres numeric, which arrives as a string over PostgREST -- coercing it here is what
 * keeps `modifierDelta` doing arithmetic instead of string concatenation.
 */
export async function listItemModifierGroups(
  supabase: FavornomsClient,
  menuItemId: string,
): Promise<ModifierGroup[]> {
  const { data, error } = await supabase
    .from('menu_item_modifiers')
    .select(
      `display_order,
       modifier_group_id,
       modifier_groups!inner(
         id, name, min_select, max_select, is_required, selection_type, display_order,
         modifier_options(id, name, price_delta, is_default, is_active)
       )`,
    )
    .eq('menu_item_id', menuItemId)
    .order('display_order');

  if (error) throw error;

  return (data ?? [])
    .map((row) => {
      // A many-to-one embed comes back as an object, but PostgREST types it as an array.
      const g = (Array.isArray(row.modifier_groups) ? row.modifier_groups[0] : row.modifier_groups) as
        | {
            id: string;
            name: string;
            min_select: number | null;
            max_select: number | null;
            is_required: boolean | null;
            selection_type: string | null;
            display_order: number | null;
            modifier_options: Array<{
              id: string;
              name: string;
              price_delta: number | string | null;
              is_default: boolean | null;
              is_active: boolean | null;
            }> | null;
          }
        | null
        | undefined;
      if (!g) return null;
      const group: ModifierGroup = {
        id: g.id,
        name: g.name,
        min_select: g.min_select ?? 0,
        max_select: g.max_select ?? 1,
        is_required: !!g.is_required,
        selection_type: g.selection_type === 'multiple' ? 'multiple' : 'single',
        display_order: g.display_order ?? 0,
        options: (g.modifier_options ?? [])
          .filter((o) => o.is_active)
          .map((o) => ({
            id: o.id,
            name: o.name,
            price_delta: Number(o.price_delta ?? 0),
            is_default: !!o.is_default,
            is_active: true,
          }))
          // Cheapest first, so "no cheese" sits above "add bacon" the way a menu reads.
          .sort((a, b) => a.price_delta - b.price_delta),
      };
      return group;
    })
    .filter((g): g is ModifierGroup => g !== null);
}
