import { getTranslations } from 'next-intl/server';
import { getEntitlementsForBranch } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { branchMenuLink } from '../qr/_lib/menu-url';
import { BrandsManager } from './_components/brands-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function BrandsPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('brands');
  // Only the sidebar used to hide this page. A manager who typed the URL still got the brand
  // editor and the Add branch button, which opens a paid branch seat. Ask for the same
  // capability the sidebar and the brands RLS policies use.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/brands`);
  if (!can('brand.edit')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [brandsRes, branchesRes, restaurantRes, entitlements] = await Promise.all([
    supabase
      .from('brands')
      .select(
        'id, slug, name, theme, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, is_default, created_at',
      )
      .eq('restaurant_id', branch.restaurant_id)
      .order('is_default', { ascending: false })
      .order('created_at', { ascending: true }),
    supabase
      .from('branches')
      .select('id, name, slug, brand_id, is_active, timezone, custom_domain')
      .eq('restaurant_id', branch.restaurant_id)
      .order('created_at', { ascending: true }),
    supabase
      .from('restaurants')
      .select('id, name, slug, loyalty_scope, storefront, brand_settings')
      .eq('id', branch.restaurant_id)
      .maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
  ]);

  const restaurantSlug = restaurantRes.data?.slug;
  const branches = (branchesRes.data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    brand_id: b.brand_id,
    is_active: b.is_active,
    timezone: b.timezone,
    // The same builder the QR page prints from, so the link shown here and the printed code
    // can never point at different places (a custom domain wins over /r/<restaurant>/<branch>).
    storefront_url: branchMenuLink(b.slug, restaurantSlug, b.custom_domain).url,
  }));

  // What the Create brand button starts a restaurant's first brand with. The name is the one its
  // storefronts already show (tenant.ts falls back to restaurants.name while there is no brand),
  // else this branch's, never a translated word: it is stored and published. The theme is the
  // restaurant's own (restaurants.brand_settings), which is what an unlinked branch renders, so
  // linking a branch to the new brand does not repaint it in the editor's placeholder orange. The
  // logo and the brand name have columns of their own and are left out.
  const newBrandName = restaurantRes.data?.name?.trim() || branch.name;
  const brandSettings = restaurantRes.data?.brand_settings;
  const newBrandTheme = Object.fromEntries(
    Object.entries(
      brandSettings && typeof brandSettings === 'object' && !Array.isArray(brandSettings) ? brandSettings : {},
    ).filter(([key]) => key !== 'brandName' && key !== 'logoUrl'),
  );

  return (
    <BrandsManager
      restaurantId={branch.restaurant_id}
      newBrand={{ name: newBrandName, theme: newBrandTheme }}
      // Display only: a failed read falls back to the word for "restaurant" in the viewer's language.
      restaurantName={restaurantRes.data?.name ?? t('restaurantFallback')}
      loyaltyScope={
        // Fallback matches the column default ('brand'), so a failed read never
        // renders the opposite of what the database will actually enforce.
        (restaurantRes.data?.loyalty_scope as 'branch' | 'brand') ?? 'brand'
      }
      currentBranchId={branchId}
      brands={(brandsRes.data ?? []) as never}
      branches={branches}
      storefront={(restaurantRes.data?.storefront ?? {}) as Record<string, unknown>}
      entitlements={entitlements}
    />
  );
}
