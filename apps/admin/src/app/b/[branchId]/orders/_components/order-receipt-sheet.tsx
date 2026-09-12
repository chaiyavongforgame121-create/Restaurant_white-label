'use client';

import * as React from 'react';
import { Printer, ReceiptText } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { formatPhone, formatCurrency } from '@favornoms/shared';
import { Button, Card, Sheet } from '@favornoms/ui';
import { printReceiptViaBrowser } from '@favornoms/ui/printer';
import { modifierLabel, parseLineModifiers } from './order-lines';
import { formatReceiptAddress, toReceiptInput, type ReceiptOrder } from './receipt-input';

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
  const [open, setOpen] = React.useState(false);
  const [order, setOrder] = React.useState<ReceiptOrder | null>(null);
  const [paymentMethod, setPaymentMethod] = React.useState<string | null>(null);
  const [receiptNumber, setReceiptNumber] = React.useState<string | null>(null);
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
      const { data, error: readErr } = await supabase
        .from('orders')
        .select(
          `order_number, status, channel, created_at,
           subtotal, delivery_fee, service_fee, tax_amount, tip_amount,
           discount_amount, total, customer_name, customer_phone, delivery_address,
           order_items(item_name, quantity, unit_price, subtotal, notes, modifiers),
           payments(method, status),
           tax_invoices(invoice_number, issued_at)`,
        )
        .eq('id', orderId)
        .maybeSingle();
      if (cancelled) return;
      setLoading(false);
      if (readErr || !data) {
        setError(readErr?.message ?? 'That order could no longer be read.');
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
      setOrder(data as unknown as ReceiptOrder);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, order, orderId]);

  // Printing happens in its own window, never in this one. The Sheet is a fixed,
  // body-scroll-locking overlay nested deep in the page, so window.print() here would put
  // the sidebar and the whole order table on the paper. printReceiptViaBrowser opens the
  // 80mm document and fires its own print dialog. It must stay synchronous inside the
  // click handler or the pop-up blocker eats window.open.
  const print = () => {
    if (!order) return;
    printReceiptViaBrowser(
      toReceiptInput(order, { branchName, branchAddress, paymentMethod, currency }),
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
        Receipt
      </Button>

      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        side="right"
        title={`Receipt · ${orderNumber}`}
        ariaLabel={`Receipt for order ${orderNumber}`}
      >
        <div className="space-y-4 px-5 pb-8">
          {loading && (
            <p role="status" className="text-sm text-muted-foreground">
              Loading receipt…
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
                  This order was {order.status}. The receipt records what was ordered, not
                  that it was paid for.
                </p>
              )}

              {canPrint && (
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Prints the 80mm receipt in a new window.
                  </p>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={print}
                    leftIcon={<Printer className="h-4 w-4" />}
                  >
                    Print
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
}: {
  order: ReceiptOrder;
  branchName: string;
  branchAddress: string | null;
  paymentMethod: string | null;
  receiptNumber: string | null;
  currency: string;
}) {
  const created = new Date(order.created_at).toLocaleString('en-US', {
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
          Receipt · {receiptNumber ?? order.order_number}
        </p>
      </div>

      <dl className="mt-5 grid grid-cols-2 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Date</dt>
        <dd className="text-right">{created}</dd>
        <dt className="text-muted-foreground">Channel</dt>
        <dd className="text-right capitalize">{order.channel.replace('_', '-')}</dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd className="text-right capitalize">{order.status.replace('_', ' ')}</dd>
        {order.customer_name && (
          <>
            <dt className="text-muted-foreground">Customer</dt>
            <dd className="text-right">{order.customer_name}</dd>
          </>
        )}
        {order.customer_phone && (
          <>
            <dt className="text-muted-foreground">Phone</dt>
            <dd className="text-right">{formatPhone(order.customer_phone)}</dd>
          </>
        )}
      </dl>

      <hr className="my-5 border-dashed border-border" />

      <table className="w-full text-sm">
        <tbody>
          {order.order_items.map((item, i) => {
            // The unit shown is derived from the line, not read from unit_price: subtotal
            // carries the options the diner chose, so the base price beside it read as a
            // receipt that could not add up (2 × $8.00 against a $17.50 line).
            const qty = Math.max(1, Number(item.quantity) || 1);
            const mods = parseLineModifiers(item.modifiers);
            return (
              <tr key={i} className="border-b border-dashed border-border/60 last:border-0">
                <td className="py-2">
                  <div className="font-medium">{item.item_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {item.quantity} × {money(n(item.subtotal) / qty)}
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
        <Row label="Subtotal" value={money(n(order.subtotal))} />
        {n(order.delivery_fee) > 0 && <Row label="Delivery" value={money(n(order.delivery_fee))} />}
        {n(order.service_fee) > 0 && (
          <Row label="Service fee" value={money(n(order.service_fee))} />
        )}
        {n(order.discount_amount) > 0 && (
          <Row label="Discount" value={`-${money(n(order.discount_amount))}`} />
        )}
        {n(order.tax_amount) > 0 && <Row label="Sales tax" value={money(n(order.tax_amount))} />}
        {n(order.tip_amount) > 0 && <Row label="Tip" value={money(n(order.tip_amount))} />}
        <div className="my-1 h-px bg-border" />
        <Row label={`Total (${currency})`} value={money(n(order.total))} emphasize />
        {paymentMethod && <Row label="Paid via" value={paymentMethod.replace('_', ' ')} />}
      </dl>

      {address && (
        <p className="mt-4 border-t border-dashed border-border pt-3 text-xs text-muted-foreground">
          Deliver to: {address}
        </p>
      )}
    </Card>
  );
}

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
