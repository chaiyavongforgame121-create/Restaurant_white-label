import { getTranslations } from 'next-intl/server';
import { branchDayKey, shiftDayKey, startOfBranchDayUtc } from '@favornoms/database/queries';
import { sortOrderLines } from '@favornoms/shared';
import { Card } from '@favornoms/ui';
import { getBranchAccess } from '@/lib/capabilities';
import { OrderFilters } from './_components/order-filters';
import { PaymentApprovals, type PendingTransfer } from './_components/payment-approvals';
import { DeliveryIssues, type DeliveryIssue } from './_components/delivery-issues';
import {
  OrderMobileCard,
  OrderTableRow,
  type OrderRowContext,
  type OrderRowData,
} from './_components/order-row';
import type { OrderLine } from './_components/order-lines';
import {
  isStripeCardPayment,
  summarizeCardPaymentsByOrder,
  type CardPaymentRow,
  type CardPaymentSummary,
  type PaymentRefundRow,
} from './_components/card-refund';

interface Props {
  params: Promise<{ branchId: string }>;
  searchParams: Promise<{
    q?: string;
    status?: string;
    channel?: string;
    when?: string;
    range?: string;
    from?: string;
    to?: string;
  }>;
}

export default async function OrdersPage({ params, searchParams }: Props) {
  const { branchId } = await params;
  const { q, status, channel, when, range, from, to } = await searchParams;
  const { supabase, branch, can } = await getBranchAccess(branchId, `/b/${branchId}/orders`);
  const t = await getTranslations('orders');

  // Two capabilities decide the receipt drawer. orders.view is who may read the order at
  // all; receipt.reprint is the counter's named right to put one on paper. The matrix
  // seeds receipt.reprint for `cashier` alone and a cashier cannot open the back office,
  // so asking for it on its own would hide printing from every role that can reach this
  // page — hence "either". Granting receipt.reprint to owner/admin/manager is a
  // role_capabilities change, and this reads correctly the day someone makes it.
  const canViewReceipt = can('orders.view');
  const canPrintReceipt = can('receipt.reprint') || can('orders.view');

  // getBranchAccess reads only id/name/restaurant_id. A receipt header needs the address a
  // diner would recognise and the currency the branch actually charges in; the date range
  // needs the timezone whose calendar days the merchant counts in.
  const { data: branchDetail } = await supabase
    .from('branches')
    .select('address, settings, timezone')
    .eq('id', branchId)
    .maybeSingle();
  const branchAddress = branchDetail?.address ?? null;
  const branchSettings = (branchDetail?.settings ?? {}) as Record<string, unknown>;
  const currency = typeof branchSettings.currency === 'string' ? branchSettings.currency : 'USD';
  const tz = branchDetail?.timezone ?? 'America/New_York';

  // The list used to carry totals only, so the owner had to open a receipt to learn what a
  // ticket was. Items, options and notes ride along on the same query now: order_items is
  // readable under order_items_staff for anyone who can see the order, and the tables embed
  // is the one the kitchen board already uses, so a merchant sees "Table 4" here too.
  let query = supabase
    .from('orders')
    .select(
      `id, order_number, channel, status, total, customer_name, customer_phone, created_at,
       scheduled_for, held, awaiting_payment, customer_notes, kitchen_notes, delivery_address,
       tables(table_number, display_name),
       order_items(id, item_name, quantity, unit_price, subtotal, modifiers, notes, combo_id,
         category_position, item_position, created_at)`,
      // The header said "{rows.length} matching", which was really "rows returned" — with
      // no date filter and a cap of 100, "all orders" quietly meant "the newest 100 ever".
      { count: 'exact' },
    )
    .eq('branch_id', branchId);

  if (q && q.trim()) {
    const term = `%${q.trim()}%`;
    query = query.or(
      `order_number.ilike.${term},customer_name.ilike.${term},customer_phone.ilike.${term}`,
    );
  }
  if (status && status !== 'all') query = query.eq('status', status);
  if (channel && channel !== 'all') query = query.eq('channel', channel);

  // Pre-orders were invisible here. Everything sorted by created_at descending, so a
  // booking taken today for next Saturday sat at the top today and then sank out of the
  // first 100 rows long before the day it mattered — a restaurant taking pre-orders could
  // not see what was coming. `when=scheduled` inverts both filters: future bookings only,
  // soonest first, which is the order the kitchen actually needs them in.
  const scheduledOnly = when === 'scheduled';
  const heldOnly = when === 'held';
  if (scheduledOnly || heldOnly) {
    query = query.not('scheduled_for', 'is', null).gte('scheduled_for', new Date().toISOString());
    // held = accepted but deliberately withheld from the kitchen until its lead time.
    if (heldOnly) query = query.eq('held', true);
  }

  // Both the column the window applies to and the direction it runs follow the mode. A
  // scheduled list is about when the food is DUE, so "Last 7 days" there reads as the next
  // seven; windowing it on created_at would hide a booking taken six weeks ago for
  // tomorrow, which is the exact case `when=scheduled` exists for.
  const dueMode = scheduledOnly || heldOnly;
  const rangeColumn = dueMode ? 'scheduled_for' : 'created_at';

  // Resolved against the BRANCH's calendar, not the server's: bucketing on the host clock
  // is what made a New York merchant's day roll over at 8pm on the dashboard.
  const todayKey = branchDayKey(new Date(), tz);
  const spanDays = range === 'today' ? 1 : range === '7d' ? 7 : range === '30d' ? 30 : 0;
  let rangeStart: Date | null = null;
  let rangeEnd: Date | null = null; // exclusive
  if (spanDays > 0) {
    rangeStart = startOfBranchDayUtc(dueMode ? todayKey : shiftDayKey(todayKey, 1 - spanDays), tz);
    rangeEnd = startOfBranchDayUtc(shiftDayKey(todayKey, dueMode ? spanDays : 1), tz);
  } else if (range === 'custom') {
    const ymd = /^\d{4}-\d{2}-\d{2}$/; // never interpolate an unvalidated param into a filter
    if (from && ymd.test(from)) rangeStart = startOfBranchDayUtc(from, tz);
    // The end day is inclusive to a merchant, so the bound is the start of the day after.
    if (to && ymd.test(to)) rangeEnd = startOfBranchDayUtc(shiftDayKey(to, 1), tz);
  }

  // In due mode the lower bound is usually a no-op — scheduled_for is already pinned to
  // now() above — and only bites when a custom range starts in the future.
  if (rangeStart) query = query.gte(rangeColumn, rangeStart.toISOString());
  if (rangeEnd) query = query.lt(rangeColumn, rangeEnd.toISOString());

  const { data: orders, count } = await (scheduledOnly || heldOnly
    ? query.order('scheduled_for', { ascending: true })
    : query.order('created_at', { ascending: false })
  ).limit(100);

  // Card payments made through Stripe, and what has gone back on them, for the rows on screen.
  // Read apart from the orders query, not embedded in it: payments and payment_refunds need
  // payments.view, and a failed or refused read here must cost the refund pills, never the list.
  const orderIds = (orders ?? []).map((o) => o.id);
  let cardByOrder: Record<string, CardPaymentSummary> = {};
  if (orderIds.length > 0) {
    // The dispute status alone, not all of gateway_metadata: a charge a dispute has taken back has
    // nothing left to refund, so it must not be flagged "Card not refunded" (card-refund.ts).
    const { data: cardRows, error: cardErr } = await supabase
      .from('payments')
      .select(
        'id, order_id, amount, status, method, gateway, gateway_charge_id, created_at, dispute_status:gateway_metadata->>dispute_status',
      )
      .eq('branch_id', branchId)
      .eq('method', 'card')
      .in('order_id', orderIds);
    if (cardErr) console.error('[orders] card payments read failed', cardErr.message);
    const stripeRows = ((cardRows ?? []) as CardPaymentRow[]).filter(isStripeCardPayment);
    if (stripeRows.length > 0) {
      const { data: refundRows, error: refundErr } = await supabase
        .from('payment_refunds')
        .select('id, payment_id, order_id, amount, status, reason, created_at')
        .eq('branch_id', branchId)
        .in('order_id', Array.from(new Set(stripeRows.map((p) => p.order_id))));
      if (refundErr) console.error('[orders] card refunds read failed', refundErr.message);
      // Without the refunds, a summary would claim money is still on the card that may already
      // be back with the diner, so no pills at all rather than wrong ones.
      if (!refundErr) {
        cardByOrder = summarizeCardPaymentsByOrder(stripeRows, (refundRows ?? []) as PaymentRefundRow[]);
      }
    }
  }

  const rows: OrderRowData[] = (orders ?? []).map((o) => {
    // tables is a many-to-one embed, so PostgREST hands back one object (or null), but the
    // loosened client type cannot promise that — normalise the same way the kitchen does.
    const tbl = (Array.isArray(o.tables) ? o.tables[0] : o.tables) as {
      table_number: string;
      display_name: string | null;
    } | null;
    const addr = (o.delivery_address ?? null) as Record<string, unknown> | null;
    const deliveryNotes =
      typeof addr?.notes === 'string' && addr.notes.trim() ? addr.notes.trim() : null;
    return {
      id: o.id,
      order_number: o.order_number,
      channel: o.channel,
      status: o.status,
      total: Number(o.total),
      customer_name: o.customer_name,
      customer_phone: o.customer_phone,
      created_at: o.created_at,
      scheduled_for: o.scheduled_for,
      held: !!o.held,
      awaiting_payment: !!o.awaiting_payment,
      customer_notes: o.customer_notes,
      kitchen_notes: o.kitchen_notes,
      // display_name is the merchant's own name for the table and is shown as typed; only
      // the fallback built from the number is interface text.
      table_label: tbl ? tbl.display_name || t('page.tableLabel', { number: tbl.table_number }) : null,
      delivery_notes: deliveryNotes,
      // Menu order, category by category, the way the receipt and the kitchen list them; the
      // summary's first two lines come from this order too.
      lines: sortOrderLines((o.order_items ?? []) as OrderLine[]),
      card: cardByOrder[o.id] ?? null,
    };
  });

  const rowCtx: OrderRowContext = {
    branchName: branch.name,
    branchAddress,
    currency,
    canViewReceipt,
    canPrintReceipt,
  };

  // Failed deliveries that need staff attention (re-dispatch or refund).
  const { data: failedRows } = await supabase
    .from('deliveries')
    .select('id, order_id, failed_reason, failed_photo_url, orders!inner(order_number, customer_name, customer_phone)')
    .eq('branch_id', branchId)
    .eq('status', 'failed')
    .limit(20);
  const issues: DeliveryIssue[] = (failedRows ?? []).map((d) => {
    const o = (Array.isArray(d.orders) ? d.orders[0] : d.orders) as {
      order_number: string;
      customer_name: string | null;
      customer_phone: string | null;
    };
    return {
      id: d.id,
      order_id: d.order_id,
      failed_reason: d.failed_reason,
      failed_photo_url: d.failed_photo_url,
      order_number: o?.order_number ?? '—',
      customer_name: o?.customer_name ?? null,
      customer_phone: o?.customer_phone ?? null,
    };
  });

  // QR-transfer slips awaiting a decision. The order cannot leave 'pending' until one is
  // made (enforced by the orders_block_unpaid_transfer trigger), so this is surfaced above
  // the table rather than buried in a row.
  //
  // Only once the CUSTOMER has confirmed. A slip on its own is not a claim of payment — the
  // diner may still be swapping a screenshot for a clearer one — and an approval queue full
  // of half-finished uploads is noise the merchant has to re-check every time it changes.
  // customer_confirmed_at is stamped by confirm_payment_proof, i.e. by the diner pressing
  // "I've paid".
  const { data: transferRows } = await supabase
    .from('payments')
    .select('id, order_id, amount, proof_image_url, gateway_metadata, orders!inner(order_number, customer_name, customer_phone)')
    .eq('branch_id', branchId)
    .eq('method', 'transfer')
    .eq('status', 'pending')
    .not('proof_image_url', 'is', null)
    .not('gateway_metadata->customer_confirmed_at', 'is', null)
    .order('created_at', { ascending: true })
    .limit(50);

  const pendingTransfers: PendingTransfer[] = (transferRows ?? []).map((p) => {
    const o = (Array.isArray(p.orders) ? p.orders[0] : p.orders) as {
      order_number: string;
      customer_name: string | null;
      customer_phone: string | null;
    } | null;
    const meta = (p.gateway_metadata ?? {}) as Record<string, unknown>;
    return {
      payment_id: p.id,
      order_id: p.order_id,
      order_number: o?.order_number ?? '—',
      customer_name: o?.customer_name ?? null,
      customer_phone: o?.customer_phone ?? null,
      amount: Number(p.amount ?? 0),
      proof_path: (p.proof_image_url as string | null) ?? null,
      submitted_at: (meta.proof_submitted_at as string | undefined) ?? null,
    };
  });

  const matching = count ?? rows.length;

  return (
    <div className="container max-w-7xl py-8">
      <header className="mb-6 px-2 pl-16 lg:px-0">
        <h1 className="font-display text-3xl font-bold">{t('page.title')}</h1>
        <p className="mt-1 text-muted-foreground">
          {(count ?? 0) > rows.length
            ? t('page.countCapped', { count: matching, shown: rows.length })
            : t('page.count', { count: matching })}
        </p>
      </header>

      <div className="px-2 lg:px-0">
        <PaymentApprovals branchId={branchId} pending={pendingTransfers} />
        <DeliveryIssues issues={issues} />
      </div>

      <div className="mb-4 px-2 lg:px-0">
        <OrderFilters
          defaultQ={q ?? ''}
          defaultStatus={status ?? 'all'}
          defaultChannel={channel ?? 'all'}
          defaultWhen={when ?? 'all'}
          defaultRange={range ?? 'all'}
          defaultFrom={from ?? ''}
          defaultTo={to ?? ''}
        />
      </div>

      {/* Desktop table */}
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="bg-muted text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-3 py-3">{t('page.columns.orderNumber')}</th>
              <th className="px-3 py-3">{t('page.columns.channel')}</th>
              <th className="px-3 py-3">{t('page.columns.customer')}</th>
              <th className="px-3 py-3">{t('page.columns.items')}</th>
              <th className="px-3 py-3">{t('page.columns.created')}</th>
              <th className="px-3 py-3 text-right">{t('page.columns.total')}</th>
              <th className="px-3 py-3 text-center">{t('page.columns.status')}</th>
              <th className="bg-muted sticky right-0 z-20 w-px whitespace-nowrap px-3 py-3 text-right">
                {t('page.columns.actions')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((o) => (
              <OrderTableRow key={o.id} order={o} ctx={rowCtx} />
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-12 text-center text-muted-foreground">
                  {t('page.empty')}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>

      {/* Mobile cards */}
      <ul className="space-y-3 px-2 md:hidden">
        {rows.map((o) => (
          <li key={o.id}>
            <OrderMobileCard order={o} ctx={rowCtx} />
          </li>
        ))}
      </ul>
    </div>
  );
}
