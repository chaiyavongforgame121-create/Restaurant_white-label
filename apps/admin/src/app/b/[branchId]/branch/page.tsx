import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { getServerClient } from '@favornoms/database/server';
import {
  getBranchPaymentAccount,
  getEntitlementsForBranch,
  listRestaurantPaymentAccounts,
} from '@favornoms/database/queries';
import { hasFeature } from '@favornoms/shared';
import { resolveDeliveryGate } from '@/lib/delivery-gate';
import { BranchSettings } from './_components/branch-settings';

interface Props { params: Promise<{ branchId: string }> }

export default async function BranchPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: branch } = await supabase
    .from('branches')
    .select(
      'id, restaurant_id, brand_id, name, address, timezone, theme_override, settings, is_active, custom_domain, sales_tax_rate, geo_lat, geo_lng, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon',
    )
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  // The brand this branch renders from: its own if linked, otherwise the restaurant's default —
  // the same ladder resolveTenant uses. Read only for the Branding card's preview: its name is the
  // first half of "<brand> - <branch>", and its logo and icon are what a branch with none of its
  // own falls back to. The card never writes it.
  const brandQuery = branch.brand_id
    ? supabase
        .from('brands')
        .select('name, logo_url, favicon_url, icon_192_url')
        .eq('id', branch.brand_id)
        .maybeSingle()
    : supabase
        .from('brands')
        .select('name, logo_url, favicon_url, icon_192_url')
        .eq('restaurant_id', branch.restaurant_id)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true })
        .limit(1)
        .maybeSingle();

  // The delivery gate carries the catalog's prices as well as the answer: the upsell shown
  // in place of the delivery cards used to hardcode $49 while the catalog said $59, and
  // delivery is now $59 once plus $29/month FOR THIS BRANCH (docs/PACKAGING-2026-09-23.md).
  const [
    { data: restaurant },
    entitlements,
    deliveryGate,
    { data: brand },
    t,
    { data: caps },
    paymentAccount,
    restaurantPaymentAccounts,
  ] = await Promise.all([
    supabase.from('restaurants').select('name, storefront').eq('id', branch.restaurant_id).maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
    resolveDeliveryGate(supabase, branchId),
    brandQuery,
    getTranslations('branch'),
    // The settings cards save through patch_branch_settings, which needs branch.settings (owner
    // and admin). A manager opens this page too, so the cards are shown read-only to them
    // rather than refusing only after Save.
    supabase.rpc('my_capabilities', { p_branch_id: branchId }),
    // The Stripe account rows are readable with branch.settings only (RLS); anyone else gets none,
    // and the card says the setup is for the owner and admins to see.
    getBranchPaymentAccount(supabase, branchId),
    listRestaurantPaymentAccounts(supabase, branch.restaurant_id),
  ]);
  const capabilities = (caps ?? []) as string[];
  // resolveDeliveryGate asks getEntitlementsForBranch the same question hasFeature would,
  // and carries the catalog prices with it, so the upsell's answer and its numbers cannot
  // disagree.
  return (
    <BranchSettings
      branch={branch as never}
      restaurantStorefront={(restaurant?.storefront ?? null) as Record<string, unknown> | null}
      branding={{
        brandName: brand?.name?.trim() || restaurant?.name?.trim() || t('defaultRestaurantName'),
        identity: {
          logo_url: branch.logo_url,
          favicon_url: branch.favicon_url,
          icon_192_url: branch.icon_192_url,
          icon_512_url: branch.icon_512_url,
          icon_maskable_512_url: branch.icon_maskable_512_url,
          app_icon: branch.app_icon,
        },
        brandDefaults: {
          logoUrl: brand?.logo_url || null,
          iconUrl: brand?.icon_192_url || brand?.favicon_url || null,
        },
      }}
      canUseDelivery={deliveryGate.delivers}
      deliveryPrices={{
        // This branch's one-time price: 0 when its unlock was paid before, so switching
        // delivery back on is quoted as the monthly price alone, as the plan page prices it.
        once: deliveryGate.oneTimePrice,
        monthly: deliveryGate.monthlyPrice,
        alreadyUnlocked: deliveryGate.alreadyUnlocked === true,
        planHref: deliveryGate.planHref,
      }}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      canEditSettings={capabilities.includes('branch.settings')}
      cardPayments={{
        account: paymentAccount,
        restaurantAccounts: restaurantPaymentAccounts,
        // Connecting, sharing and disconnecting choose where the branch's card money is paid:
        // billing.manage, the owner's. stripe-connect-onboard checks the same thing itself.
        canConnect: capabilities.includes('billing.manage'),
        canView: capabilities.includes('branch.settings'),
      }}
    />
  );
}
