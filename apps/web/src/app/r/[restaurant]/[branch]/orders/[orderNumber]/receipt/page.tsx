import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { resolveTenant } from '@/lib/tenant';
import { CustomerReceipt } from './_components/customer-receipt';

interface Props {
  params: Promise<{ restaurant: string; branch: string; orderNumber: string }>;
}

export const metadata = { title: 'Receipt · Favornoms' };

export default async function CustomerReceiptPage({ params }: Props) {
  const { restaurant, branch, orderNumber } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const supabase = await getServerClient();
  const { data: order } = await supabase
    .from('orders')
    .select(
      `id, order_number, status, channel, created_at,
       subtotal, delivery_fee, service_fee, tax_amount, tip_amount,
       discount_amount, total, customer_name, customer_phone,
       delivery_address,
       order_items(item_name, quantity, unit_price, subtotal)`,
    )
    .eq('branch_id', tenant.branch.id)
    .eq('order_number', orderNumber)
    .maybeSingle();
  if (!order) notFound();

  return (
    <CustomerReceipt
      order={order as never}
      branchName={tenant.branch.name}
      branchAddress={tenant.branch.address}
    />
  );
}
