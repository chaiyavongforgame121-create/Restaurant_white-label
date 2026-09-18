import { getTranslations } from 'next-intl/server';
import { getEntitlementsForBranch, isPlatformAdmin } from '@favornoms/database/queries';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { branchMenuLink } from '../qr/_lib/menu-url';
import { BrandsManager, type CopyCaps } from './_components/brands-manager';

interface Props { params: Promise<{ branchId: string }> }

export default async function BrandsPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('brands');
  // Only the sidebar used to hide this page. A manager who typed the URL still got the brand
  // editor and the Add branch button, which opens a paid branch seat. Ask for the same
  // capability the sidebar and the brands RLS policies use.
  const { supabase, user, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/brands`);
  if (!can('brand.edit')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [brandsRes, branchesRes, restaurantRes, entitlements, myRowsRes, platformAdmin] = await Promise.all([
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
      .select('id, name, slug, storefront, brand_settings, owner_user_id')
      .eq('id', branch.restaurant_id)
      .maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
    supabase
      .from('staff_members')
      .select('role, branch_id')
      .eq('user_id', user.id)
      .eq('restaurant_id', branch.restaurant_id)
      .eq('status', 'active'),
    isPlatformAdmin(supabase),
  ]);

  // The restaurant row (storefront defaults) and the brand are shared by every branch, so their
  // policies (private.user_administers_restaurant) take the owner or an admin of every branch,
  // not an admin pinned to one. Mirrored here only to lock the editors instead of letting a save
  // bounce; the policies are the boundary.
  const canEditShared =
    platformAdmin ||
    restaurantRes.data?.owner_user_id === user.id ||
    (myRowsRes.data ?? []).some((r) => r.role === 'owner' || (r.branch_id === null && r.role === 'admin'));

  // What the Add branch dialog may copy from each active branch: copy_branch_setup asks for
  // menu.manage and branch.settings at the source (loyalty.manage for the loyalty programme).
  // Offering a branch the viewer cannot copy from let create_branch take a paid seat and the copy
  // fail with not_authorized straight after. Owners and platform admins copy from anywhere; anyone
  // else is asked per branch they have a row at (every branch with a restaurant-wide row).
  const myRows = myRowsRes.data ?? [];
  const copiesFromAnywhere =
    platformAdmin || restaurantRes.data?.owner_user_id === user.id || myRows.some((r) => r.role === 'owner');
  const restaurantWideRow = myRows.some((r) => r.branch_id === null);
  const copyCapsEntries = await Promise.all(
    (branchesRes.data ?? [])
      .filter((b) => b.is_active)
      .map(async (b): Promise<[string, CopyCaps]> => {
        if (copiesFromAnywhere) return [b.id, { menu: true, settings: true, loyalty: true }];
        if (b.id === branchId) {
          return [b.id, { menu: can('menu.manage'), settings: can('branch.settings'), loyalty: can('loyalty.manage') }];
        }
        if (!restaurantWideRow && !myRows.some((r) => r.branch_id === b.id)) {
          return [b.id, { menu: false, settings: false, loyalty: false }];
        }
        const { data } = await supabase.rpc('my_capabilities', { p_branch_id: b.id });
        const caps = (data ?? []) as string[];
        return [
          b.id,
          {
            menu: caps.includes('menu.manage'),
            settings: caps.includes('branch.settings'),
            loyalty: caps.includes('loyalty.manage'),
          },
        ];
      }),
  );
  const copyCaps: Record<string, CopyCaps> = Object.fromEntries(copyCapsEntries);

  const restaurantSlug = restaurantRes.data?.slug;
  const branches = (branchesRes.data ?? []).map((b) => ({
    id: b.id,
    name: b.name,
    slug: b.slug,
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
      currentBranchId={branchId}
      canEditShared={canEditShared}
      copyCaps={copyCaps}
      brands={(brandsRes.data ?? []) as never}
      branches={branches}
      storefront={(restaurantRes.data?.storefront ?? {}) as Record<string, unknown>}
      entitlements={entitlements}
    />
  );
}
