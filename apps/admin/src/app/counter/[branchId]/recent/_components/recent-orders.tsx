'use client';

import * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, RefreshCcw, Undo2 } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';

interface OrderRow {
  id: string;
  order_number: string;
  status: string;
  total: number | string;
  customer_name: string | null;
  created_at: string;
  channel: string;
}

interface Props {
  branchId: string;
  orders: OrderRow[];
}

export function RecentOrders({ branchId, orders: initial }: Props) {
  const [orders, setOrders] = React.useState(initial);
  const [refundingId, setRefundingId] = React.useState<string | null>(null);

  const refund = async (order: OrderRow) => {
    const raw = window.prompt(
      `Refund order ${order.order_number}. Enter amount in USD (max $${Number(order.total).toFixed(2)}). Leave blank to refund in full.`,
      String(Number(order.total).toFixed(2)),
    );
    if (raw === null) return;
    const amount = raw.trim() ? Number(raw) : Number(order.total);
    if (!Number.isFinite(amount) || amount <= 0) {
      window.alert('Invalid amount.');
      return;
    }
    const reason = window.prompt('Reason (optional)') ?? null;
    setRefundingId(order.id);
    try {
      const supabase = getBrowserClient();
      const { error } = await supabase.rpc('refund_order', {
        p_order_id: order.id,
        p_amount: amount,
        p_reason: reason,
      });
      if (error) {
        window.alert(`Refund failed: ${error.message}`);
        return;
      }
      setOrders((curr) =>
        curr.map((o) => (o.id === order.id ? { ...o, status: amount >= Number(order.total) ? 'refunded' : o.status } : o)),
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
          <ArrowLeft className="h-4 w-4" /> Back to counter
        </Link>
        <h1 className="font-display text-2xl font-bold">Recent orders</h1>
      </header>

      {orders.length === 0 ? (
        <Card className="p-10 text-center text-muted-foreground">
          <RefreshCcw className="mx-auto h-10 w-10 opacity-40" />
          <p className="mt-3 text-sm">No orders in the last 24 hours.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {orders.map((o) => (
            <Card key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <p className="font-display text-lg font-bold">{o.order_number}</p>
                  <Badge variant={o.status === 'refunded' ? 'danger' : o.status === 'completed' ? 'success' : 'muted'}>
                    {o.status}
                  </Badge>
                  <span className="text-xs text-muted-foreground">· {o.channel}</span>
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {o.customer_name ?? 'Walk-in'} · {new Date(o.created_at).toLocaleString()}
                </p>
              </div>
              <div className="flex items-center gap-3">
                <span className="font-display text-xl font-bold text-primary tabular-nums">
                  {formatCurrency(Number(o.total))}
                </span>
                <Button
                  variant="outline"
                  size="md"
                  loading={refundingId === o.id}
                  disabled={o.status === 'refunded' || o.status === 'cancelled'}
                  onClick={() => refund(o)}
                  leftIcon={<Undo2 className="h-4 w-4" />}
                >
                  Refund
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
