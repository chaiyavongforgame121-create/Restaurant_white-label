'use client';

import * as React from 'react';
import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import { ArrowLeft, QrCode, RefreshCcw, Undo2 } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, intlLocaleFor, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, useAlert, useConfirm, usePrompt } from '@favornoms/ui';
import { describeSettleError } from '../../_components/counter-errors';
import { forgetUnsettled } from '../../_components/unsettled-transfers';
// The one receipt drawer in the product. It loads the order itself and prints the same
// 80mm document the till prints after a sale, so the counter reuses it rather than growing
// a second, drifting copy — /b/[branchId]/orders sits behind backoffice.access, which the
// cashier who holds receipt.reprint does not have.
import { OrderReceiptButton } from '@/app/b/[branchId]/orders/_components/order-receipt-sheet';

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total: number | string;
  customer_name: string | null;
  created_at: string;
  channel: string;
  scheduled_for: string | null;
  held: boolean | null;
  source?: string | null;
  /** A transfer on this order is not completed yet (payments_sync_awaiting keeps it current). */
  awaiting_payment?: boolean | null;
}

interface Props {
  branchId: string;
  orders: OrderRow[];
  branchName: string;
  branchAddress: string | null;
  currency: string;
  /** receipt.reprint, or the orders.view right that lets this account read the order. */
  canPrintReceipt: boolean;
  /** orders.refund at this branch. Absent means the old behaviour: show the button. */
  canRefund?: boolean;
}

/** A QR sale rung up at the till whose payment was never recorded: it is off the kitchen board
 *  until someone records it, and record_counter_transfer only settles counter/pos orders. */
const awaitingCounterTransfer = (o: OrderRow) =>
  o.awaiting_payment === true &&
  (o.source === 'counter' || o.source === 'pos') &&
  o.status !== 'cancelled' &&
  o.status !== 'refunded';

// Statuses and channels are stored codes; only these have a label under `counter.status` /
// `counter.channel`. Anything newer shows its code rather than a missing-key path.
const STATUS_LABELS = new Set([
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded',
]);
const CHANNEL_LABELS = new Set(['dine_in', 'pickup', 'delivery', 'qr_ordering']);

// refund_order's raised codes, keyed to `counter.recent.*` messages.
const REFUND_ERRORS: Array<[string, string]> = [
  ['not_authorized', 'recent.refundNotAuthorized'],
  ['invalid_refund_amount', 'recent.refundInvalidAmount'],
  ['order_not_found', 'recent.refundNotFound'],
  ['auth_required', 'recent.refundAuthRequired'],
  // Earlier refunds of the order already count toward its total (refund_order keeps a running sum).
  ['refund_exceeds_remaining', 'recent.refundExceedsRemaining'],
  // The diner paid online by card: the money has to go back through Stripe, which the back
  // office's Orders page does. This button only ever wrote the order's status.
  ['card_refund_required', 'recent.refundOnlineCard'],
];

/** The placeholder the till writes when nobody gave a name. Stored in English. */
const WALK_IN = 'Walk-in';

export function RecentOrders({
  branchId,
  orders: initial,
  branchName,
  branchAddress,
  currency,
  canPrintReceipt,
  canRefund = true,
}: Props) {
  const t = useTranslations('counter');
  const rawLocale = useLocale();
  const intlLocale = intlLocaleFor(isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE);
  const [orders, setOrders] = React.useState(initial);
  const [refundingId, setRefundingId] = React.useState<string | null>(null);
  const [settlingId, setSettlingId] = React.useState<string | null>(null);
  const prompt = usePrompt();
  const notify = useAlert();
  const confirm = useConfirm();

  /**
   * The till's "Payment received" for a QR sale it placed but could not settle. The till keeps
   * those on its own screen too; this is the way back after a reload, another device, or Dismiss.
   */
  const recordTransfer = async (order: OrderRow) => {
    const ok = await confirm({
      title: t('recent.recordQrTitle', { number: order.order_number }),
      body: t('recent.recordQrBody', { amount: formatCurrency(Number(order.total), currency) }),
      confirmLabel: t('recent.recordQrConfirm'),
    });
    if (!ok) return;
    setSettlingId(order.id);
    try {
      const { error } = await getBrowserClient().rpc('record_counter_transfer', { p_order_id: order.id });
      if (error) {
        console.error('counter: record_counter_transfer failed', error.message);
        const settle = describeSettleError(error.message);
        await notify({
          title: t('recent.recordQrFailed'),
          body: settle.code
            ? `${t(`settle.${settle.key}`)} (${settle.code})`
            : t(`settle.${settle.key}`),
        });
        return;
      }
      forgetUnsettled(branchId, order.id);
      setOrders((curr) =>
        curr.map((o) =>
          o.id === order.id
            ? { ...o, awaiting_payment: false, status: o.status === 'pending' ? 'confirmed' : o.status }
            : o,
        ),
      );
    } finally {
      setSettlingId(null);
    }
  };

  const refund = async (order: OrderRow) => {
    const raw = await prompt({
      title: t('recent.refundTitle', { number: order.order_number }),
      // In the branch's own currency: this said "USD" and a dollar sign at every branch.
      body: t('recent.refundBody', { max: formatCurrency(Number(order.total), currency) }),
      defaultValue: String(Number(order.total).toFixed(2)),
      confirmLabel: t('recent.continue'),
    });
    if (raw === null) return;
    const amount = raw.trim() ? Number(raw) : Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      await notify({
        title: t('recent.invalidAmount'),
        body: t('recent.invalidAmountBody'),
      });
      return;
    }
    // This is the button that moves the money — the amount step only said "Continue".
    //
    // Cancelling here now ABORTS. window.prompt returned null on cancel and the old code
    // coalesced that to "no reason" and refunded anyway, which was survivable when the
    // buttons were the browser's; it is not when this dialog's own buttons read Cancel and
    // Refund. An empty reason is still fine — that is the Refund button with nothing typed.
    const reason = await prompt({ title: t('recent.reasonTitle'), confirmLabel: t('recent.refund') });
    if (reason === null) return;
    setRefundingId(order.id);
    try {
      const supabase = getBrowserClient();
      const { data, error } = await supabase.rpc('refund_order', {
        p_order_id: order.id,
        p_amount: amount,
        p_reason: reason.trim() || null,
      });
      if (error) {
        // The database's wording is logged; the cashier gets a sentence they can act on.
        const known = REFUND_ERRORS.find(([code]) => error.message.includes(code));
        if (!known) console.error('counter: refund_order failed', error.message);
        await notify({
          title: t('recent.refundFailed'),
          body: known ? t(known[1]) : t('errors.generic'),
        });
        return;
      }
      // refund_order says whether this refund, with the ones before it, covered the order; the
      // amount alone does not, since two partial refunds can add up to the whole.
      const inFull = (data as { refunded_in_full?: unknown } | null)?.refunded_in_full;
      const refundedNow = typeof inFull === 'boolean' ? inFull : amount >= Number(order.total);
      setOrders((curr) =>
        curr.map((o) => (o.id === order.id ? { ...o, status: refundedNow ? 'refunded' : o.status } : o)),
      );
    } finally {
      setRefundingId(null);
    }
  };

  return (
    <div className="container max-w-4xl py-6">
      <header className="mb-5 flex items-center justify-between">
        <Link
          href={`/counter/${branchId}`}
          className="focus-ring inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" /> {t('recent.back')}
        </Link>
        <h1 className="font-display text-2xl font-bold">{t('recent.title')}</h1>
      </header>

      {orders.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <RefreshCcw className="mx-auto h-10 w-10 opacity-40" />
          <p className="mt-3 text-sm">{t('recent.empty')}</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => {
            const customer =
              o.customer_name == null || o.customer_name === WALK_IN
                ? t('recent.walkIn')
                : o.customer_name;
            return (
              <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <p className="font-display text-lg font-bold">{o.order_number}</p>
                    <Badge variant={o.status === 'refunded' ? 'danger' : o.status === 'completed' ? 'success' : 'muted'}>
                      {STATUS_LABELS.has(o.status) ? t(`status.${o.status}`) : o.status}
                    </Badge>
                    <span className="text-xs text-muted-foreground">
                      · {CHANNEL_LABELS.has(o.channel) ? t(`channel.${o.channel}`) : o.channel}
                    </span>
                    {o.scheduled_for && (
                      <Badge variant="warning">
                        {o.held ? t('recent.scheduled') : t('recent.dueNow')}
                      </Badge>
                    )}
                    {awaitingCounterTransfer(o) && (
                      <Badge variant="danger">{t('recent.awaitingQr')}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {o.scheduled_for
                      ? t('recent.metaScheduled', {
                          customer,
                          date: new Date(o.scheduled_for).toLocaleString(intlLocale),
                        })
                      : t('recent.meta', {
                          customer,
                          date: new Date(o.created_at).toLocaleString(intlLocale),
                        })}
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <span className="font-display text-xl font-bold text-primary tabular-nums">
                    {formatCurrency(Number(o.total), currency)}
                  </span>
                  <OrderReceiptButton
                    orderId={o.id}
                    orderNumber={o.order_number}
                    branchName={branchName}
                    branchAddress={branchAddress}
                    canPrint={canPrintReceipt}
                    currency={currency}
                  />
                  {awaitingCounterTransfer(o) && (
                    <Button
                      variant="gradient"
                      size="md"
                      loading={settlingId === o.id}
                      disabled={settlingId !== null && settlingId !== o.id}
                      onClick={() => void recordTransfer(o)}
                      leftIcon={<QrCode className="h-4 w-4" />}
                    >
                      {t('recent.recordQr')}
                    </Button>
                  )}
                  {canRefund && (
                    <Button
                      variant="outline"
                      size="md"
                      loading={refundingId === o.id}
                      disabled={o.status === 'refunded' || o.status === 'cancelled'}
                      onClick={() => refund(o)}
                      leftIcon={<Undo2 className="h-4 w-4" />}
                    >
                      {t('recent.refund')}
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
