import type {
  DietaryTag,
  LocalizedText,
  MenuCategory,
  MenuItem,
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
      is_recommended, is_new, dietary_tags, rating, review_count,
      prep_time_minutes, calories, display_order
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
      is_recommended, is_new, dietary_tags, rating, review_count,
      prep_time_minutes, calories, display_order
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
    rating: row.rating != null ? Number(row.rating) : undefined,
    reviewCount: row.review_count ?? 0,
    prepTimeMinutes: row.prep_time_minutes ?? undefined,
    calories: row.calories ?? undefined,
  };
}
