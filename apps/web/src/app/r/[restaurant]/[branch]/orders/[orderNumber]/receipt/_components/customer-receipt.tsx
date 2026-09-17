'use client';

import * as React from 'react';
import { ArrowLeft, Printer } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency, intlLocaleFor } from '@favornoms/shared';
import { Button, Card, useUiLocale } from '@favornoms/ui';

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  channel: string;
  created_at: string;
  subtotal: number | string;
  delivery_fee: number | string;
  service_fee: number | string;
  tax_amount: number | string;
  tip_amount: number | string;
  discount_amount: number | string;
  total: number | string;
  customer_name: string | null;
  customer_phone: string | null;
  delivery_address: Record<string, unknown> | null;
  order_items: Array<{
    item_name: string;
    quantity: number;
    unit_price: number | string;
    subtotal: number | string;
  }>;
}

interface Props {
  order: OrderRow;
  branchName: string;
  branchAddress?: string;
}

/** Values with a label in `orders.channel` / `orders.status`. Anything else prints raw, as before. */
const KNOWN_CHANNELS = ['dine_in', 'pickup', 'delivery', 'qr_ordering'];
const KNOWN_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded',
];

export function CustomerReceipt({ order, branchName, branchAddress }: Props) {
  const t = useTranslations('orders');
  const locale = useUiLocale();
  const created = new Date(order.created_at).toLocaleString(intlLocaleFor(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const n = (v: number | string) => Number(v);

  return (
    <main className="container max-w-md py-6 print:py-0">
      <header className="mb-4 flex items-center justify-between print:hidden">
        <button
          onClick={() => history.back()}
          className="focus-ring inline-flex items-center gap-2 rounded-xl px-3 py-2 text-sm font-medium hover:bg-muted"
        >
          <ArrowLeft className="h-4 w-4" /> {t('receipt.back')}
        </button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => window.print()}
          leftIcon={<Printer className="h-4 w-4" />}
        >
          {t('receipt.print')}
        </Button>
      </header>

      <Card className="p-6 print:border-0 print:shadow-none">
        <div className="text-center">
          <h1 className="font-display text-2xl font-bold">{branchName}</h1>
          {branchAddress && <p className="mt-1 text-xs text-muted-foreground">{branchAddress}</p>}
          <p className="mt-3 inline-block rounded-full bg-muted px-3 py-1 text-xs font-semibold">
            {t('receipt.heading', { number: order.order_number })}
          </p>
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-y-1.5 text-sm">
          <dt className="text-muted-foreground">{t('receipt.date')}</dt>
          <dd className="text-right">{created}</dd>
          <dt className="text-muted-foreground">{t('receipt.channel')}</dt>
          {KNOWN_CHANNELS.includes(order.channel) ? (
            <dd className="text-right">{t(`channel.${order.channel}` as never)}</dd>
          ) : (
            <dd className="text-right capitalize">{order.channel.replace('_', '-')}</dd>
          )}
          <dt className="text-muted-foreground">{t('receipt.status')}</dt>
          {KNOWN_STATUSES.includes(order.status) ? (
            <dd className="text-right">{t(`status.${order.status}` as never)}</dd>
          ) : (
            <dd className="text-right capitalize">{order.status}</dd>
          )}
          {order.customer_name && (
            <>
              <dt className="text-muted-foreground">{t('receipt.customer')}</dt>
              <dd className="text-right">{order.customer_name}</dd>
            </>
          )}
        </dl>

        <hr className="my-5 border-dashed border-border" />

        <table className="w-full text-sm">
          <tbody>
            {order.order_items.map((it, i) => (
              <tr key={i} className="border-b border-dashed border-border/60 last:border-0">
                <td className="py-2">
                  <div className="font-medium">{it.item_name}</div>
                  <div className="text-xs text-muted-foreground">
                    {it.quantity} × {formatCurrency(n(it.unit_price))}
                  </div>
                </td>
                <td className="py-2 text-right font-display font-semibold tabular-nums">
                  {formatCurrency(n(it.subtotal))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <hr className="my-5 border-dashed border-border" />

        <dl className="space-y-1.5 text-sm">
          <Row label={t('receipt.subtotal')} value={formatCurrency(n(order.subtotal))} />
          {n(order.delivery_fee) > 0 && (
            <Row label={t('receipt.delivery')} value={formatCurrency(n(order.delivery_fee))} />
          )}
          {n(order.service_fee) > 0 && (
            <Row label={t('receipt.serviceFee')} value={formatCurrency(n(order.service_fee))} />
          )}
          {n(order.discount_amount) > 0 && (
            <Row label={t('receipt.discount')} value={`-${formatCurrency(n(order.discount_amount))}`} />
          )}
          {n(order.tax_amount) > 0 && (
            <Row label={t('receipt.salesTax')} value={formatCurrency(n(order.tax_amount))} />
          )}
          {n(order.tip_amount) > 0 && (
            <Row label={t('receipt.tip')} value={formatCurrency(n(order.tip_amount))} />
          )}
          <div className="my-1 h-px bg-border" />
          <Row
            label={t('receipt.total')}
            value={formatCurrency(n(order.total))}
            emphasize
          />
        </dl>

        <p className="mt-6 text-center text-xs text-muted-foreground">
          {t('receipt.thanks')}
        </p>
      </Card>

      <style jsx global>{`
        @media print {
          body { background: #fff; }
          .print\\:py-0 { padding-top: 0 !important; padding-bottom: 0 !important; }
        }
      `}</style>
    </main>
  );
}

function Row({ label, value, emphasize }: { label: string; value: string; emphasize?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${emphasize ? 'text-base font-bold' : ''}`}>
      <dt className={emphasize ? '' : 'text-muted-foreground'}>{label}</dt>
      <dd className={`font-display tabular-nums ${emphasize ? 'text-primary text-xl' : ''}`}>{value}</dd>
    </div>
  );
}
