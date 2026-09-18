import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import {
  InventoryView,
  type InventoryAlert,
  type InventoryItem,
  type StockCount,
  type Restock,
  type Waste,
} from './_components/inventory-view';

interface Props {
  params: Promise<{ branchId: string }>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('inventory');
  return { title: t('metaTitle') };
}

export default async function InventoryPage({ params }: Props) {
  const { branchId } = await params;
  const t = await getTranslations('inventory');

  // Only the sidebar link was gated. A cashier or a rider who typed the URL got the whole page,
  // and every button on it failed on RLS with a generic error.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/inventory`);
  if (!can('inventory.manage')) {
    return (
      <AccessDenied
        title={t('accessDenied.title')}
        reason={t('accessDenied.reason', { branch: branch.name })}
      />
    );
  }

  const [branchRes, itemsRes, alertsRes, restockRes, wasteRes, countRes] = await Promise.all([
    supabase.from('branches').select('timezone, settings').eq('id', branchId).maybeSingle(),
    supabase
      .from('menu_items')
      .select('id, name, image_url, price, track_stock, stock_quantity, low_stock_threshold, sold_out_until, is_active')
      .eq('branch_id', branchId)
      // Hidden dishes last: they are not on sale, so they sit under the ones that are.
      .order('is_active', { ascending: false })
      .order('name'),
    // The same view the dashboard's stock card reads, so both screens list the same dishes for
    // the same reason. It holds active dishes only.
    supabase
      .from('v_low_stock_items')
      .select('id, name, track_stock, stock_quantity, low_stock_threshold, sold_out_until, is_low_stock, is_86, is_sold_out')
      .eq('branch_id', branchId)
      .order('name'),
    supabase
      .from('restock_log')
      .select('id, menu_item_id, delta, cost_per_unit, supplier, notes, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('waste_log')
      .select('id, menu_item_id, quantity, reason, notes, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50),
    supabase
      .from('stock_count_log')
      .select('id, menu_item_id, counted_qty, previous_qty, notes, created_at')
      .eq('branch_id', branchId)
      .order('created_at', { ascending: false })
      .limit(50),
  ]);

  // A failed read used to render as "No restocks logged yet" or an empty table, which reads as
  // a branch with nothing in it. Log the raw text; the merchant gets a banner.
  const failures = [
    ['branch', branchRes.error],
    ['menu_items', itemsRes.error],
    ['v_low_stock_items', alertsRes.error],
    ['restock_log', restockRes.error],
    ['waste_log', wasteRes.error],
    ['stock_count_log', countRes.error],
  ].filter(([, err]) => !!err);
  for (const [what, err] of failures) console.error(`[inventory] read ${what} failed`, err);

  const settings = (branchRes.data?.settings ?? {}) as Record<string, unknown>;

  return (
    <InventoryView
      branchId={branchId}
      timezone={branchRes.data?.timezone ?? 'America/New_York'}
      currency={typeof settings.currency === 'string' && settings.currency ? settings.currency : 'USD'}
      loadFailed={failures.length > 0}
      items={(itemsRes.data ?? []) as InventoryItem[]}
      alerts={(alertsRes.data ?? []) as InventoryAlert[]}
      restocks={(restockRes.data ?? []) as Restock[]}
      waste={(wasteRes.data ?? []) as Waste[]}
      counts={(countRes.data ?? []) as StockCount[]}
    />
  );
}
