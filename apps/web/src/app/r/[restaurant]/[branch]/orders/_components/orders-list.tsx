'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { RotateCcw } from 'lucide-react';
import { formatCurrency } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card } from '@favornoms/ui';
import { useCart } from '@/store/cart';

interface OrderRow {
  id: string;
  order_number: string;
  total: number | string;
  status: string;
  created_at: string;
  order_items: Array<{ id: string; menu_item_id: string | null; item_name: string; quantity: number }>;
}

interface Props {
  orders: OrderRow[];
  base: string;
  branchId: string;
}

export function OrdersList({ orders, base, branchId }: Props) {
  const router = useRouter();
  const cartAdd = useCart((s) => s.add);
  const cartClear = useCart((s) => s.clear);
  const [reorderingId, setReorderingId] = React.useState<string | null>(null);

  const reorder = async (order: OrderRow) => {
    setReorderingId(order.id);
    try {
      const menuIds = order.order_items.map((i) => i.menu_item_id).filter((x): x is string => !!x);
      if (menuIds.length === 0) return;
      const supabase = getBrowserClient();
      // Pull live menu rows so we re-use current prices/availability.
      const { data: items } = await supabase
        .from('menu_items')
        .select('id, branch_id, category_id, name, price, image_url, is_active')
        .in('id', menuIds)
        .eq('branch_id', branchId);
      if (!items || items.length === 0) {
        alert('None of these items are available right now.');
        return;
      }
      const liveById = new Map(items.map((it) => [it.id, it]));
      cartClear();
      for (const line of order.order_items) {
        const m = line.menu_item_id ? liveById.get(line.menu_item_id) : null;
        if (!m || !m.is_active) continue;
        cartAdd(
          {
            id: m.id,
            branchId: m.branch_id,
            categoryId: m.category_id ?? '',
            name: m.name,
            price: Number(m.price),
            imageUrl: m.image_url ?? null,
          } as never,
          line.quantity,
        );
      }
      router.push(`${base}/cart`);
    } finally {
      setReorderingId(null);
    }
  };

  return (
    <div className="container max-w-2xl pt-6">
      <h1 className="font-display text-2xl font-bold">Your orders</h1>
      <ul className="mt-4 space-y-3">
        {orders.map((order) => (
          <li key={order.id}>
            <Card className="p-4 transition-shadow hover:shadow-warm">
              <div className="flex items-start justify-between gap-3">
                <Link href={`${base}/orders/${order.order_number}`} className="focus-ring flex-1">
                  <p className="text-xs font-medium text-muted-foreground">{order.order_number}</p>
                  <p className="mt-1 font-display text-lg font-semibold">
                    {order.order_items.length} items · {formatCurrency(Number(order.total))}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {order.order_items.map((i) => i.item_name).join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(order.created_at).toLocaleString()}
                  </p>
                </Link>
                <div className="flex flex-col items-end gap-2">
                  <Badge variant="solid">{order.status.replace('_', ' ')}</Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => reorder(order)}
                    loading={reorderingId === order.id}
                    leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                  >
                    Reorder
                  </Button>
                </div>
              </div>
            </Card>
          </li>
        ))}
      </ul>
    </div>
  );
}
