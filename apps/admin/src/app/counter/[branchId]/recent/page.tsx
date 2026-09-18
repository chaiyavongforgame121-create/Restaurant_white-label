import { getBranchAccess } from '@/lib/capabilities';
import { RecentOrders } from './_components/recent-orders';

interface Props {
  params: Promise<{ branchId: string }>;
}

export default async function RecentOrdersPage({ params }: Props) {
  const { branchId } = await params;
  // The receipt drawer needs the branch's address and currency, and the capability set
  // decides whether it may put paper in a printer. receipt.reprint is the right named for
  // this job and the matrix seeds it for `cashier` alone — a role with no back office at
  // all, which is why the only surface for it until now was one the cashier cannot reach.
  const { supabase, branch, can } = await getBranchAccess(branchId, `/counter/${branchId}/recent`);
  const { data: branchDetail } = await supabase
    .from('branches')
    .select('address, settings')
    .eq('id', branchId)
    .maybeSingle();
  const branchSettings = (branchDetail?.settings ?? {}) as Record<string, unknown>;
  const currency = typeof branchSettings.currency === 'string' ? branchSettings.currency : 'USD';

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  // A pickup ordered three days ago for today is the counter's problem today, so
  // a flat 24h floor on created_at hid exactly the orders staff most need to see.
  // Keep it in the list while its scheduled slot is recent or still ahead.
  const { data: orders } = await supabase
    .from('orders')
    // source + awaiting_payment: a QR sale rung up here whose payment the till could not record
    // is settled from this page (record_counter_transfer), since the back office's approval
    // queue only lists storefront transfers that come with a slip.
    .select(
      'id, order_number, status, total, customer_name, created_at, channel, scheduled_for, held, source, awaiting_payment',
    )
    .eq('branch_id', branchId)
    .or(`created_at.gte.${since},scheduled_for.gte.${since}`)
    .order('created_at', { ascending: false })
    .limit(50);

  // Order by the time the food is wanted, not the time it was typed in, so a
  // pre-order sits among today's tickets instead of at the bottom of the page.
  const sorted = [...(orders ?? [])].sort(
    (a, b) =>
      new Date(b.scheduled_for ?? b.created_at).getTime() -
      new Date(a.scheduled_for ?? a.created_at).getTime(),
  );

  return (
    <RecentOrders
      branchId={branchId}
      orders={sorted as never[]}
      branchName={branch.name}
      branchAddress={branchDetail?.address ?? null}
      currency={currency}
      canPrintReceipt={can('receipt.reprint') || can('orders.view')}
      // refund_order checks orders.refund at this branch; a cashier does not hold it, and a
      // button that can only answer "not allowed" is noise at a busy till.
      canRefund={can('orders.refund')}
    />
  );
}
