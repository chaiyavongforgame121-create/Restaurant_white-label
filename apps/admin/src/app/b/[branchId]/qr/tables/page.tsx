import { notFound } from 'next/navigation';
import { getBranchAccess } from '@/lib/capabilities';
import { AccessDenied } from '@/components/access-denied';
import { branchMenuLink } from '../_lib/menu-url';
import { TableQrManager, type BranchTable } from './_components/table-qr-manager';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function TableQrPage({ params }: Props) {
  const { branchId } = await params;
  // A table is floor setup, gated the same way RLS gates it — the codes are printed once
  // and live on the furniture, so re-issuing one is not a day-to-day action.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/qr/tables`);

  if (!can('branch.settings')) {
    return (
      <AccessDenied
        title="No table access"
        reason={`Only the owner or an admin can set up tables at ${branch.name}.`}
      />
    );
  }

  const { data: branchRow } = await supabase
    .from('branches')
    .select('id, name, slug, custom_domain, restaurant_id')
    .eq('id', branchId)
    .maybeSingle();
  if (!branchRow) notFound();

  const { data: restaurant } = await supabase
    .from('restaurants')
    .select('slug, name')
    .eq('id', branchRow.restaurant_id)
    .maybeSingle();

  const { url, missingSlugs } = branchMenuLink(
    branchRow.slug,
    restaurant?.slug,
    branchRow.custom_domain,
  );

  const { data: tables } = await supabase
    .from('tables')
    .select(
      'id, table_number, display_name, capacity, zone, table_type, sort_order, status, is_active, qr_code_token',
    )
    .eq('branch_id', branchId)
    // sort_order first: table_number is text, so on its own '10' sorts before '2' and a
    // floor of more than nine tables prints out of order.
    .order('sort_order')
    .order('table_number');

  return (
    <TableQrManager
      branchId={branchId}
      branchName={branchRow.name}
      restaurantName={restaurant?.name ?? ''}
      menuUrl={url}
      missingSlugs={missingSlugs}
      initialTables={(tables ?? []) as BranchTable[]}
    />
  );
}
