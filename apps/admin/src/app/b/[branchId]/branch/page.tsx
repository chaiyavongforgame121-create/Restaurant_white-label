import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { Info } from 'lucide-react';
import {
  getBranchDeliveryEnabled,
  getBranchPaymentAccount,
  getEntitlementsForBranch,
  listRestaurantPaymentAccounts,
} from '@favornoms/database/queries';
import { hasFeature, type WeekdayWindow } from '@favornoms/shared';
import { getBranchAccess } from '@/lib/capabilities';
import { deliveryOffReason } from '@/lib/delivery-gate-model';
import { PageAccessDenied } from '@/components/page-access-denied';
import { BranchSettings } from './_components/branch-settings';
import { ClosuresManager } from './_components/closures-manager';
import { HoursEditor } from './_components/hours-editor';

interface Props { params: Promise<{ branchId: string }> }

export default async function BranchPage({ params }: Props) {
  const { branchId } = await params;
  const { supabase, branch: access, can } = await getBranchAccess(branchId, `/b/${branchId}/branch`);

  // Two doors (owner decision D8, 2026-10-16). The branch's identity, tax, active switch,
  // timezone, theme, payments and storefront are branch.settings: the owner's and the admin's.
  // Opening hours and closures stay the manager's day-to-day work — they are written under
  // user_manages_branch (owner, admin, manager), and menu.manage is held by exactly those roles,
  // the same stand-in the dashboard's setup checklist uses. So a manager gets those two cards and
  // nothing else; this page used to show a manager every card, read-only, and let them save the
  // identity ones. Anyone else (a cashier) gets the card that says whose screen this is.
  if (!can('branch.settings')) {
    if (!can('menu.manage')) return <PageAccessDenied area="branch" branchName={access.name} />;
    const { data: clock } = await supabase
      .from('branches')
      .select('timezone')
      .eq('id', branchId)
      .maybeSingle();
    return <BranchHoursOnly branchId={branchId} timezone={clock?.timezone ?? 'America/New_York'} />;
  }

  const { data: branch } = await supabase
    .from('branches')
    .select(
      'id, restaurant_id, brand_id, name, address, timezone, theme_override, settings, is_active, sales_tax_rate, geo_lat, geo_lng, logo_url, favicon_url, icon_192_url, icon_512_url, icon_maskable_512_url, app_icon',
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

  const [
    { data: restaurant },
    entitlements,
    deliverySwitch,
    { data: brand },
    t,
    paymentAccount,
    restaurantPaymentAccounts,
    deliveryHoursRows,
    openingHoursRows,
  ] = await Promise.all([
    supabase.from('restaurants').select('name, storefront').eq('id', branch.restaurant_id).maybeSingle(),
    getEntitlementsForBranch(supabase, branchId),
    // The "Delivery at this branch" switch. A failed read is null, not a guess: the card then
    // says it could not be read and stays put, rather than offering to switch on a branch
    // that may already deliver.
    getBranchDeliveryEnabled(supabase, branchId).catch((e: unknown) => {
      console.error('Branch settings: could not read the delivery switch:', e);
      return null;
    }),
    brandQuery,
    getTranslations('branch'),
    // The Stripe account rows are readable with branch.settings only (RLS), which every viewer
    // who gets this far holds.
    getBranchPaymentAccount(supabase, branchId),
    listRestaurantPaymentAccounts(supabase, branch.restaurant_id),
    // The Delivery card's saved windows. With "Limit delivery to set hours" on they, not opening
    // hours, are when this branch delivers, so the Scheduled orders card previews bookings from
    // them. Read here, not in that card, so the router.refresh() after the Delivery card saves
    // hands down the new windows together with the new switch in branch.settings.
    supabase
      .from('branch_delivery_hours')
      .select('day_of_week, opens_at, closes_at')
      .eq('branch_id', branchId),
    // Opening hours, for the same two cards' previews: the Scheduled orders card's "Customers will
    // see" (opening hours decide while delivery hours are off) and the Delivery card's "outside
    // opening hours" note. Read here for the same reason: the Opening hours card refreshes the page
    // after it saves, and both previews follow the hours just saved instead of those at page load.
    supabase
      .from('branch_hours')
      .select('day_of_week, opens_at, closes_at')
      .eq('branch_id', branchId),
  ]);
  // A failed read is null, not an empty week: empty means "on with no windows, no delivery", and
  // the card would preview that as fact.
  if (deliveryHoursRows.error) {
    console.error('Branch settings: could not read the delivery hours:', deliveryHoursRows.error);
  }
  const deliveryWindows: WeekdayWindow[] | null = deliveryHoursRows.error
    ? null
    : (deliveryHoursRows.data ?? []).map((row) => ({
        day_of_week: row.day_of_week,
        // Postgres `time` arrives as 'HH:MM:SS'; the hours helpers read 'HH:MM'.
        opens_at: String(row.opens_at).slice(0, 5),
        closes_at: String(row.closes_at).slice(0, 5),
      }));
  // Null, not empty, when the read fails: no rows means "always open", and the previews would
  // show that as fact.
  if (openingHoursRows.error) {
    console.error('Branch settings: could not read the opening hours:', openingHoursRows.error);
  }
  const openingHours: WeekdayWindow[] | null = openingHoursRows.error
    ? null
    : (openingHoursRows.data ?? []).map((row) => ({
        day_of_week: row.day_of_week,
        opens_at: String(row.opens_at).slice(0, 5),
        closes_at: String(row.closes_at).slice(0, 5),
      }));
  // The branch payload's delivery answer already includes this switch; what it cannot say
  // alone is whether the restaurant has delivery at all. deliveryOffReason is the rule every
  // locked delivery screen uses, so this card's note and those screens agree.
  const deliveryReason = deliveryOffReason(
    hasFeature(entitlements, 'delivery'),
    entitlements.entitled,
    deliverySwitch,
  );
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
      delivery={{
        switchOn: deliverySwitch,
        // 'notAvailable' blames the restaurant. That holds when it has lapsed (the switch
        // cannot matter then) or when the switch was read as on; an unread switch claims
        // nothing, and the card already says it could not be read.
        restaurantOff:
          deliveryReason === 'notAvailable' && (!entitlements.entitled || deliverySwitch === true),
      }}
      deliveryWindows={deliveryWindows}
      openingHours={openingHours}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      // Always true past the gate above; kept as a prop so the cards still lock themselves if this
      // page is ever opened wider again.
      canEditSettings={can('branch.settings')}
      cardPayments={{
        account: paymentAccount,
        restaurantAccounts: restaurantPaymentAccounts,
        // Connecting, sharing and disconnecting choose where the branch's card money is paid:
        // billing.manage, the owner's. stripe-connect-onboard checks the same thing itself.
        canConnect: can('billing.manage'),
        canView: can('branch.settings'),
      }}
    />
  );
}

/**
 * The manager's branch page: opening hours and closures, the two cards whose writes
 * (branch_hours, branch_closures) stay with user_manages_branch. Same cards, same order and
 * same container as the full page, so the dashboard's "Set your opening hours" link lands on
 * the same thing for everyone.
 */
async function BranchHoursOnly({ branchId, timezone }: { branchId: string; timezone: string }) {
  const [t, tAccess] = await Promise.all([
    getTranslations('branch'),
    getTranslations('shell.pageAccess'),
  ]);
  return (
    <div className="container max-w-3xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('settings.title')}</h1>
      </header>
      <div className="space-y-5 px-2 lg:px-0">
        <p className="flex items-start gap-2 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{tAccess('branchHoursOnly')}</span>
        </p>
        <HoursEditor branchId={branchId} timezone={timezone} />
        <ClosuresManager branchId={branchId} timezone={timezone} />
      </div>
    </div>
  );
}
