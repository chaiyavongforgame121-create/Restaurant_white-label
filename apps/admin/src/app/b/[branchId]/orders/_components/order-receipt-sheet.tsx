'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { Printer, ReceiptText } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { formatPhone, formatCurrency, formatUnitPrice, sortOrderLines } from '@favornoms/shared';
import { Button, Card, Sheet } from '@favornoms/ui';
import { printReceiptViaBrowser } from '@favornoms/ui/printer';
import { lineUnitPrice, modifierLabel, parseLineModifiers } from './order-lines';
import { useIntlLocale, useOrderLabels } from './order-labels';
import {
  formatReceiptAddress,
  toReceiptInput,
  type ReceiptOrder,
  type ReceiptRefund,
} from './receipt-input';

interface Props {
  orderId: string;
  orderNumber: string;
  branchName: string;
  branchAddress: string | null;
  /** receipt.reprint, or the orders.view right that lets this account read the order. */
  canPrint: boolean;
  currency: string;
}

export function OrderReceiptButton({
  orderId,
  orderNumber,
  branchName,
  branchAddress,
  canPrint,
  currency,
}: Props) {
  const t = useTranslations('orders');
  const [open, setOpen] = React.useState(false);
  const [order, setOrder] = React.useState<ReceiptOrder | null>(null);
  const [paymentMethod, setPaymentMethod] = React.useState<string | null>(null);
  const [receiptNumber, setReceiptNumber] = React.useState<string | null>(null);
  const [refunds, setRefunds] = React.useState<ReceiptRefund[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  // Loaded when the sheet opens, not when the row renders: a hundred rows would be a
  // hundred round trips for a drawer the operator opens once. Same shape as RefundDialog.
  React.useEffect(() => {
    if (!open || order) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      const supabase = getBrowserClient();
      const [{ data, error: readErr }, { data: refundRows, error: refundErr }] = await Promise.all([
        supabase
          .from('orders')
          .select(
            `order_number, status, channel, created_at,
             subtotal, delivery_fee, service_fee, tax_amount, tip_amount,
             discount_amount, total, customer_name, customer_phone, delivery_address,
             order_items(id, item_name, quantity, unit_price, subtotal, modifier_total, notes, modifiers,
               category_position, item_position, created_at),
             payments(method, status),
             tax_invoices(invoice_number, issued_at)`,
          )
          .eq('id', orderId)
          .maybeSingle(),
        // Card refunds made through Stripe, pending ones included: a receipt for an order whose
        // card was given back, in part or whole, must not read as fully paid. Read on its own so
        // a refused read (payments.view) costs these lines and not the receipt; failed and
        // canceled refunds moved no money and are left off.
        supabase
          .from('payment_refunds')
          .select('amount, status, created_at')
          .eq('order_id', orderId)
          .in('status', ['pending', 'succeeded'])
          .order('created_at', { ascending: true }),
      ]);
      if (cancelled) return;
      setLoading(false);
      if (refundErr) console.error('[orders] receipt refunds read failed', refundErr.message);
      setRefunds(
        ((refundRows ?? []) as Array<{ amount: number | string; status: string; created_at: string }>).map(
          (r) => ({ amount: Number(r.amount), status: r.status, createdAt: r.created_at }),
        ),
      );
      if (readErr || !data) {
        // The database's own wording is for the console, not for the person at the counter.
        if (readErr) console.error('[orders] receipt read failed', readErr.message);
        setError(t('receipt.loadFailed'));
        return;
      }

      // payments_staff_read wants payments.view, and PostgREST answers an embed the reader
      // may not see with [] rather than an error — so a kitchen account gets a receipt with
      // no payment line instead of a broken sheet.
      const payments = (data.payments ?? []) as Array<{ method: string; status: string }>;
      const settled = payments.find((p) => p.status === 'completed') ?? payments[0];
      setPaymentMethod(settled?.method ?? null);

      // tax_invoices is readable only through a staff_members row, so the restaurant's
      // owner sees [] here. The pill falls back to the order number rather than blanking.
      const invoices = (data.tax_invoices ?? []) as Array<{ invoice_number: string }>;
      setReceiptNumber(invoices[invoices.length - 1]?.invoice_number ?? null);
      // Menu order, category by category, on screen and on the paper printed from it.
      const read = data as unknown as ReceiptOrder;
      setOrder({ ...read, order_items: sortOrderLines(read.order_items ?? []) });
    })();
    return () => {
      cancelled = true;
    };
    // t is left out on purpose: a language switch must not re-read an order already on screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, order, orderId]);

  // Printing happens in its own window, never in this one. The Sheet is a fixed,
  // body-scroll-locking overlay nested deep in the page, so window.print() here would put
  // the sidebar and the whole order table on the paper. printReceiptViaBrowser opens the
  // 80mm document and fires its own print dialog. It must stay synchronous inside the
  // click handler or the pop-up blocker eats window.open.
  //
  // The paper itself stays English: thermal printer code pages cannot print Thai or
  // Vietnamese (docs/i18n/CONVENTIONS.md).
  const print = () => {
    if (!order) return;
    printReceiptViaBrowser(
      toReceiptInput(order, { branchName, branchAddress, paymentMethod, currency, refunds }),
    );
  };

  const voided = order !== null && ['cancelled', 'refunded'].includes(order.status);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        leftIcon={<ReceiptText className="h-4 w-4" />}
      >
        {t('receipt.button')}
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        title={t('receipt.title', { number: orderNumber })}
        ariaLabel={t('receipt.sheetLabel', { number: orderNumber })}
      >
        <div className="space-y-4 px-5 pb-8">
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              {t('receipt.loading')}
            </p>
          )}
          {error && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}

          {order && (
            <>
              {voided && (
                <p
                  role="status"
                  className="rounded-xl bg-warning/10 px-3 py-2 text-sm text-warning"
                >
                  {order.status === 'refunded'
                    ? t('receipt.voidedRefunded')
                    : t('receipt.voidedCancelled')}
                </p>
              )}

              {canPrint && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">{t('receipt.printHint')}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={print}
                    leftIcon={<Printer className="h-4 w-4" />}
                  >
                    {t('receipt.print')}
                  </Button>
                </div>
              )}

              <ReceiptCard
                order={order}
                branchName={branchName}
                branchAddress={branchAddress}
                paymentMethod={paymentMethod}
                receiptNumber={receiptNumber}
                currency={currency}
                refunds={refunds}
              />
            </>
          )}
        </div>
      </Sheet>
    </>
  );
}

function ReceiptCard({
  order,
  branchName,
  branchAddress,
  paymentMethod,
  receiptNumber,
  currency,
  refunds,
}: {
  order: ReceiptOrder;
  branchName: string;
  branchAddress: string | null;
  paymentMethod: string | null;
  receiptNumber: string | null;
  currency: string;
  refunds: ReceiptRefund[];
}) {
  const t = useTranslations('orders');
  const labels = useOrderLabels();
  const intlLocale = useIntlLocale();
  const created = new Date(order.created_at).toLocaleString(intlLocale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const n = (v: number | string) => Number(v);
  const money = (v: number) => formatCurrency(v, currency);
  const address = formatReceiptAddress(order.delivery_address);

  return (
    <Card className="p-6">
      <div className="text-center">
        <h2 className="font-display text-2xl font-bold">{branchName}</h2>
        {branchAddress && <p className="mt-1 text-xs text-muted-foreground">{branchAddress}</p>}
        <p className="mt-3 inline-block rounded-full bg-muted px-3 py-1 text-xs font-semibold">
          {t('receipt.title', { number: receiptNumber ?? order.order_number })}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">{t('receipt.date')}</dt>
        <dd className="text-right">{created}</dd>
        <dt className="text-muted-foreground">{t('receipt.channel')}</dt>
        <dd className="text-right">{labels.channel(order.channel)}</dd>
        <dt className="text-muted-foreground">{t('receipt.status')}</dt>
        <dd className="text-right">{labels.status(order.status)}</dd>
        {order.customer_name && (
          <>
            <dt className="text-muted-foreground">{t('receipt.customer')}</dt>
            <dd className="text-right">{order.customer_name}</dd>
          </>
        )}
        {order.customer_phone && (
          <>
            <dt className="text-muted-foreground">{t('receipt.phone')}</dt>
            <dd className="text-right">{formatPhone(order.customer_phone)}</dd>
          </>
        )}
      </dl>

      <hr className="my-5 border-dashed border-border" />

      <table className="w-full text-sm">
        <tbody>
          {order.order_items.map((item, i) => {
            // The unit shown carries the options (the plain unit_price beside a $17.50 line read
            // as 2 × $8.00, a receipt that could not add up) and keeps its four decimals: the
            // charged line divided and rounded to the cent printed seven $7.995 happy-hour sets
            // as "7 × $8.00" beside $55.97. The line itself is always the charged subtotal.
            const mods = parseLineModifiers(item.modifiers);
            return (
              <tr key={i} className="border-b border-dashed border-border/60 last:border-0">
                <td className="py-2">
                  <div className="font-medium">{item.item_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.quantity} × {formatUnitPrice(lineUnitPrice(item), currency)}
                  </div>
                  {mods.length > 0 && (
                    <div className="text-xs text-muted-foreground">
                      {mods.map((m) => modifierLabel(m, currency)).join(', ')}
                    </div>
                  )}
                  {item.notes && <div className="text-xs text-muted-foreground">{item.notes}</div>}
                </td>
                <td className="py-2 text-right font-display font-semibold tabular-nums">
                  {money(n(item.subtotal))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <hr className="my-5 border-dashed border-border" />

      <dl className="space-y-1.5 text-sm">
        <Row label={t('receipt.subtotal')} value={money(n(order.subtotal))} />
        {n(order.delivery_fee) > 0 && (
          <Row label={t('receipt.deliveryFee')} value={money(n(order.delivery_fee))} />
        )}
        {n(order.service_fee) > 0 && (
          <Row label={t('receipt.serviceFee')} value={money(n(order.service_fee))} />
        )}
        {n(order.discount_amount) > 0 && (
          <Row label={t('receipt.discount')} value={`-${money(n(order.discount_amount))}`} />
        )}
        {n(order.tax_amount) > 0 && (
          <Row label={t('receipt.salesTax')} value={money(n(order.tax_amount))} />
        )}
        {n(order.tip_amount) > 0 && <Row label={t('receipt.tip')} value={money(n(order.tip_amount))} />}
        <div className="my-1 h-px bg-border" />
        <Row label={t('receipt.total', { currency })} value={money(n(order.total))} emphasize />
        {paymentMethod && (
          <Row label={t('receipt.paidVia')} value={labels.paymentMethod(paymentMethod)} />
        )}
        {refunds.map((r, i) => (
          <Row
            key={i}
            label={
              r.status === 'succeeded'
                ? t('receipt.refundedToCard', { date: fmtRefundDate(r.createdAt, intlLocale) })
                : t('receipt.refundPendingToCard', { date: fmtRefundDate(r.createdAt, intlLocale) })
            }
            value={`-${money(r.amount)}`}
          />
        ))}
      </dl>

      {address && (
        <p className="mt-4 border-t border-dashed border-border pt-3 text-xs text-muted-foreground">
          {t('receipt.deliverTo', { address })}
        </p>
      )}
    </Card>
  );
}

const fmtRefundDate = (iso: string, intlLocale: string) =>
  new Date(iso).toLocaleDateString(intlLocale, { month: 'short', day: 'numeric' });

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${emphasize ? 'text-base font-bold' : ''}`}>
      <dt className={emphasize ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`font-display tabular-nums ${emphasize ? 'text-xl text-primary' : ''}`}>
        {value}
      </dd>
    </div>
  );
}
