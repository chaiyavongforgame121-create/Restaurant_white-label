import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  getEntitlementsForBranch,
  listActiveCombos,
  listCategories,
  listMenuItems,
  listTableStates,
} from '@favornoms/database/queries';
import { hasFeature, parseServiceFeePercent, sortItemsInMenuOrder } from '@favornoms/shared';
import { getBranchAccess } from '@/lib/capabilities';
import { SuspensionScreen } from '@/components/suspension-screen';
import { CounterView, type CounterQrTransfer } from './_components/counter-view';
import { effectivePriceMap, type EffectivePriceRow } from './_components/counter-pricing';

interface Props {
  params: Promise<{ branchId: string }>;
}

const text = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const coord = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export default async function CounterPage({ params }: Props) {
  const { branchId } = await params;
  // The layout has already refused anyone without counter.access here; this is for the hint
  // that only someone who can fix the branch's settings should see.
  const { supabase, can } = await getBranchAccess(branchId, `/counter/${branchId}`);
  const tr = await getTranslations('counter');
  // sales_tax_rate and settings ride along because the till has to price the cart the way
  // place-order will. Without them the Charge button quoted the food alone while the server
  // charged tax and the card fee on top, and the drawer came up short by the difference.
  // geo and timezone are for the delivery form: where the map opens, and which country a
  // phone number typed without its +code belongs to.
  const { data: branch } = await supabase
    .from('branches')
    .select('id, name, sales_tax_rate, settings, geo_lat, geo_lng, timezone')
    .eq('id', branchId)
    .maybeSingle();
  if (!branch) notFound();
  const settings = (branch.settings ?? {}) as Record<string, unknown>;
  const nowIso = new Date().toISOString();
  const [categories, unsortedItems, entitlements, floor, combos, effective, soldOut] = await Promise.all([
    listCategories(supabase, branchId),
    listMenuItems(supabase, branchId),
    getEntitlementsForBranch(supabase, branchId),
    // The till used to take the table as free text, so a typo rang a dine-in order up
    // against no table at all. Picking a real row is also what lets place-order attach the
    // order to the sitting the diners' phones are already adding to.
    listTableStates(supabase, branchId),
    // The same view the storefront reads. A deal a diner can order from their phone was
    // unsellable at the till, so a customer who walked in asking for it got it keyed as
    // separate dishes at separate prices. Each combo and each dish in it carries is_available,
    // worked out the way place-order will (on sale, not 86'd, enough stock for the combo's own
    // quantity), which the till cannot tell from its menu alone.
    listActiveCombos(supabase, branchId),
    // Happy hour. place-order re-prices every dish through this function, so the till has to
    // quote from it too, or the customer pays the list price for a dish the order records at
    // half of it. Re-read every minute on the client, because happy hours start and end while
    // the till is open.
    supabase.rpc('get_effective_prices', { p_branch_id: branchId }),
    // Dishes 86'd until a time that has not come yet. Nothing is written when an 86 expires,
    // so the till schedules its own refresh for the earliest one, and says "until 5:00 PM".
    supabase
      .from('menu_items')
      .select('id, sold_out_until')
      .eq('branch_id', branchId)
      .gt('sold_out_until', nowIso)
      .order('sold_out_until', { ascending: true }),
  ]);
  // In the admin's order: category by category, then dish by dish. display_order is a position
  // inside a category, so listing by it alone interleaved every category's first dishes.
  const items = sortItemsInMenuOrder(unsortedItems, categories);
  const seatedTableIds = new Set(floor.sessions.map((s) => s.table_id));
  const tables = floor.tables
    .filter((t) => t.is_active)
    .map((t) => ({
      id: t.id,
      number: t.table_number,
      label: t.display_name?.trim() || tr('tableLabel', { number: t.table_number }),
      seated: seatedTableIds.has(t.id),
    }));
  // Gate the till at the page, not the layout: /counter/[branchId]/recent must
  // stay reachable while suspended so staff can look up and reprint an order
  // that was already taken. Without the gate a cashier would ring a whole sale
  // and only hit the BEFORE INSERT trigger at "Charge", in front of a customer.
  if (!entitlements.entitled) {
    return <SuspensionScreen branchId={branchId} branchName={branch.name} surface="counter" />;
  }

  // THIS branch's payment QR, from Branch settings -> Payment methods. Never another branch's:
  // each branch collects into its own account, and a branch without one shows no QR button.
  const qr = (settings.qr_transfer ?? null) as Record<string, unknown> | null;
  const qrImage = text(qr?.image_url);
  const qrTransfer: CounterQrTransfer | null = qrImage
    ? { imageUrl: qrImage, accountName: text(qr?.account_name), instructions: text(qr?.instructions) }
    : null;

  const soldOutUntil: Record<string, string> = {};
  for (const row of soldOut.data ?? []) {
    if (row.sold_out_until) soldOutUntil[row.id] = row.sold_out_until;
  }
  const lat = coord(branch.geo_lat);
  const lng = coord(branch.geo_lng);

  return (
    <CounterView
      branchId={branchId}
      branchName={branch.name}
      categories={categories}
      items={items}
      tables={tables}
      combos={combos}
      canUseCard={hasFeature(entitlements, 'card_payment')}
      // getEntitlementsForBranch resolves the payload FOR this branch, so this is "THIS
      // branch delivers" — delivery is bought per branch (docs/PACKAGING-2026-09-23.md §2).
      // The till the cashier is standing at is the branch being asked about.
      canDeliver={hasFeature(entitlements, 'delivery')}
      salesTaxRate={Number(branch.sales_tax_rate ?? 0)}
      serviceFeePercent={parseServiceFeePercent(settings)}
      // place-order's flat fee for a delivery with no map pin (or one quote_delivery cannot
      // price). A pinned address is quoted by distance instead, on screen and on the server.
      deliveryFeeFlat={Number(settings.delivery_fee ?? 3.99)}
      qrTransfer={qrTransfer}
      canEditBranchSettings={can('branch.settings')}
      effectivePrices={effectivePriceMap((effective.data ?? []) as EffectivePriceRow[])}
      soldOutUntil={soldOutUntil}
      branchCenter={lat != null && lng != null ? { lat, lng } : null}
      branchTimezone={branch.timezone ?? null}
    />
  );
}
