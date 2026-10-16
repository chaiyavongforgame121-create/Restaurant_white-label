import { getBranchAccess } from '@/lib/capabilities';
import { PageAccessDenied } from '@/components/page-access-denied';
import { ReceiptsList } from './_components/receipts-list';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function ReceiptsPage({ params }: Props) {
  const { branchId } = await params;
  // The tax receipts issued for this branch's orders: the order list's own gate, which is
  // also what the sidebar entry asks.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/receipts`);
  if (!can('orders.view')) return <PageAccessDenied area="receipts" branchName={branch.name} />;
  const { data: receipts } = await supabase
    .from('tax_invoices')
    .select('id, invoice_number, buyer_name, total, status, issued_at, order_id, orders(order_number)')
    .eq('branch_id', branchId)
    .order('issued_at', { ascending: false })
    .limit(200);

  return <ReceiptsList branchId={branchId} receipts={(receipts ?? []) as never[]} />;
}
