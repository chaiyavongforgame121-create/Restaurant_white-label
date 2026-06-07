import { getServerClient } from '@favornoms/database/server';
import { ReceiptsList } from './_components/receipts-list';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function ReceiptsPage({ params }: Props) {
  const { branchId } = await params;
  const supabase = await getServerClient();
  const { data: receipts } = await supabase
    .from('tax_invoices')
    .select('id, invoice_number, buyer_name, total, status, issued_at, order_id, orders(order_number)')
    .eq('branch_id', branchId)
    .order('issued_at', { ascending: false })
    .limit(200);

  return <ReceiptsList branchId={branchId} receipts={(receipts ?? []) as never[]} />;
}
