import { notFound } from 'next/navigation';
import { getServerClient } from '@favornoms/database/server';
import { getOrderByNumber } from '@favornoms/database/queries';
import { resolveTenant } from '@/lib/tenant';
import { OrderTracking } from './_components/order-tracking';

export const dynamic = 'force-dynamic';

interface Props {
  params: Promise<{ restaurant: string; branch: string; orderNumber: string }>;
}

export default async function OrderDetailPage({ params }: Props) {
  const { restaurant, branch, orderNumber } = await params;
  const tenant = await resolveTenant(restaurant, branch);
  const supabase = await getServerClient();
  const order = await getOrderByNumber(supabase, tenant.branch.id, orderNumber);
  if (!order) notFound();
  // PostgREST returns null (not []) for left joins with no related rows.
  // OrderTracking expects array — normalize here.
  const normalized = {
    ...order,
    order_items: order.order_items ?? [],
    payments: Array.isArray(order.payments) ? order.payments : order.payments ? [order.payments] : [],
    deliveries: Array.isArray(order.deliveries) ? order.deliveries : order.deliveries ? [order.deliveries] : [],
  };
  return (
    <OrderTracking
      initialOrder={normalized as never}
      branchId={tenant.branch.id}
      branchLocation={tenant.branch.geoLocation}
      // The QR moved off checkout: a diner should not be asked to pay before the order
      // exists. It is shown here, against a real order number they can quote in the note.
      qrTransfer={
        ((tenant.branch.settings as unknown as Record<string, unknown> | null)?.qr_transfer ?? null) as {
          image_url?: string;
          account_name?: string;
          instructions?: string;
        } | null
      }
    />
  );
}
