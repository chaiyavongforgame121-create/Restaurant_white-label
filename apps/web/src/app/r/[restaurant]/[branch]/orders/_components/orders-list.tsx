'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import {
  CheckCircle2, ChefHat, Clock, MapPin, QrCode, Receipt, RotateCcw,
  ShoppingBag, Store, XCircle, type LucideIcon,
} from 'lucide-react';
import { formatCurrency, intlLocaleFor } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { Badge, Button, Card, RiderIcon, useUiLocale } from '@favornoms/ui';
import { useCart } from '@/store/cart';

interface OrderRow {
  id: string;
  order_number: string;
  total: number | string;
  status: string;
  /** `order_channel` enum — how the order was placed. */
  channel: string;
  created_at: string;
  order_items: Array<{
    id: string;
    menu_item_id: string | null;
    combo_id?: string | null;
    item_name: string;
    quantity: number;
    notes?: string | null;
    modifiers?: Array<{ group_id: string; option_id: string; name: string; price_delta: number }> | null;
  }>;
}

interface Props {
  orders: OrderRow[];
  base: string;
  branchId: string;
}

/** Keyed by the `order_channel` value; the label is `orders.channel.<value>`. */
const CHANNEL_META: Record<string, { Icon: LucideIcon }> = {
  dine_in: { Icon: Store },
  pickup: { Icon: ShoppingBag },
  delivery: { Icon: RiderIcon },
  qr_ordering: { Icon: QrCode },
};

/**
 * One entry per `order_status` enum value — all 8 are mapped, so nothing falls
 * through to the humanized default. The label is `orders.status.<value>`.
 *
 * Colour rules, both learned the hard way:
 *  1. Never `default`, `solid` or `accent`. Those resolve to --primary/--accent,
 *     which ThemeProvider injects from the branch's own theme, so on a tenant with
 *     a green accent "Out for delivery" rendered as if the order were complete.
 *     Only --success/--warning/--danger/--info are tenant-invariant.
 *  2. Never `muted`. bg-muted against bg-card is a 1.11:1 tint — invisible. That
 *     hit `pending` specifically, i.e. every freshly placed order, which is
 *     exactly the row the diner looks at first.
 *
 * There are more statuses than there are safe hues, so the icon is the second
 * channel: it is what keeps ready/completed and confirmed/out_for_delivery
 * tellable apart at a glance. Icons match the tracking stepper in
 * orders/[orderNumber]/_components/order-tracking.tsx so the same stage looks the
 * same on both screens.
 */
const STATUS_META: Record<
  string,
  { variant: React.ComponentProps<typeof Badge>['variant']; Icon: LucideIcon }
> = {
  pending: { variant: 'neutral', Icon: Clock },
  confirmed: { variant: 'info', Icon: CheckCircle2 },
  preparing: { variant: 'warning', Icon: ChefHat },
  ready: { variant: 'success', Icon: Receipt },
  out_for_delivery: { variant: 'info', Icon: RiderIcon },
  completed: { variant: 'success', Icon: MapPin },
  cancelled: { variant: 'danger', Icon: XCircle },
  refunded: { variant: 'danger', Icon: RotateCcw },
};

function humanize(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function OrdersList({ orders, base, branchId }: Props) {
  const t = useTranslations('orders');
  const locale = useUiLocale();
  const router = useRouter();
  const cartAdd = useCart((s) => s.add);
  const cartAddCombo = useCart((s) => s.addCombo);
  const cartClear = useCart((s) => s.clear);
  const [reorderingId, setReorderingId] = React.useState<string | null>(null);

  const reorder = async (order: OrderRow) => {
    setReorderingId(order.id);
    try {
      const supabase = getBrowserClient();
      const itemLines = order.order_items.filter((l) => l.menu_item_id);
      const comboLines = order.order_items.filter((l) => !l.menu_item_id && l.combo_id);
      const menuIds = [...new Set(itemLines.map((l) => l.menu_item_id as string))];
      const comboIds = [...new Set(comboLines.map((l) => l.combo_id as string))];
      const optionIds = [...new Set(itemLines.flatMap((l) => (l.modifiers ?? []).map((m) => m.option_id)))];

      // Live rows only — current prices, current availability. Anything that no
      // longer exists (or is 86'd) gets dropped and reported, never silently.
      const [{ data: items }, { data: combos }, { data: options }] = await Promise.all([
        menuIds.length
          ? supabase.from('menu_items').select('id, branch_id, category_id, name, price, image_url, is_active').in('id', menuIds).eq('branch_id', branchId)
          : Promise.resolve({ data: [] as never[] }),
        comboIds.length
          ? supabase.from('combo_sets').select('id, branch_id, name, image_url, total_price, is_active, combo_items(quantity, menu_items(name))').in('id', comboIds).eq('branch_id', branchId)
          : Promise.resolve({ data: [] as never[] }),
        optionIds.length
          ? supabase.from('modifier_options').select('id, group_id, name, price_delta, is_active, modifier_groups(name)').in('id', optionIds)
          : Promise.resolve({ data: [] as never[] }),
      ]);

      const liveById = new Map((items ?? []).map((it) => [it.id, it]));
      const liveComboById = new Map((combos ?? []).map((c) => [c.id, c]));
      const liveOptById = new Map((options ?? []).map((o) => [o.id, o]));

      let dropped = 0;
      type PendingAdd = () => void;
      const adds: PendingAdd[] = [];

      for (const line of order.order_items) {
        if (line.menu_item_id) {
          const m = liveById.get(line.menu_item_id);
          if (!m || !m.is_active) { dropped += 1; continue; }
          const mods = (line.modifiers ?? []).flatMap((sel) => {
            const live = liveOptById.get(sel.option_id);
            if (!live || !live.is_active) { dropped += 1; return []; }
            const grp = Array.isArray(live.modifier_groups) ? live.modifier_groups[0] : live.modifier_groups;
            return [{
              group_id: live.group_id,
              group_name: (grp as { name?: string } | null)?.name ?? 'Options',
              option_id: live.id,
              option_name: live.name,
              price_delta: Number(live.price_delta),
            }];
          });
          adds.push(() => cartAdd(
            {
              id: m.id,
              branchId: m.branch_id,
              categoryId: m.category_id ?? '',
              name: m.name,
              price: Number(m.price),
              imageUrl: m.image_url ?? null,
            } as never,
            line.quantity,
            line.notes ?? undefined,
            mods.length > 0 ? mods : undefined,
          ));
        } else if (line.combo_id) {
          const c = liveComboById.get(line.combo_id);
          if (!c || !c.is_active) { dropped += 1; continue; }
          const contents = ((c.combo_items ?? []) as Array<{ quantity: number; menu_items: { name: string } | Array<{ name: string }> | null }>)
            .map((ci) => {
              const mi = Array.isArray(ci.menu_items) ? ci.menu_items[0] : ci.menu_items;
              return { item_name: mi?.name ?? '', quantity: ci.quantity };
            });
          adds.push(() => cartAddCombo(
            {
              comboId: c.id,
              name: c.name,
              imageUrl: c.image_url ?? null,
              totalPrice: Number(c.total_price),
              branchId: c.branch_id,
              contents,
            },
            line.quantity,
          ));
        }
      }

      if (adds.length === 0) {
        alert(t('list.reorderNoneAvailable'));
        return;
      }
      cartClear();
      for (const apply of adds) apply();
      if (dropped > 0) {
        alert(t('list.reorderSomeDropped'));
      }
      router.push(`${base}/cart`);
    } finally {
      setReorderingId(null);
    }
  };

  return (
    <div className="container max-w-2xl pt-6">
      <h1 className="font-display text-2xl font-bold">{t('title')}</h1>
      <ul className="mt-4 space-y-3">
        {orders.map((order) => (
          <li key={order.id}>
            <Card className="p-4 transition-shadow hover:shadow-warm">
              <div className="flex items-start justify-between gap-3">
                <Link href={`${base}/orders/${order.order_number}`} className="focus-ring flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{order.order_number}</p>
                    <ChannelBadge channel={order.channel} />
                  </div>
                  <p className="mt-1 font-display text-lg font-semibold">
                    {t('list.summary', {
                      count: order.order_items.length,
                      total: formatCurrency(Number(order.total)),
                    })}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {order.order_items.map((i) => i.item_name).join(', ')}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(order.created_at).toLocaleString(intlLocaleFor(locale))}
                  </p>
                </Link>
                <div className="flex flex-col items-end gap-2">
                  <StatusBadge status={order.status} />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => reorder(order)}
                    loading={reorderingId === order.id}
                    leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                  >
                    {t('list.reorder')}
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

function StatusBadge({ status }: { status: string }) {
  const t = useTranslations('orders');
  const meta = STATUS_META[status];
  // A status added to the enum later must still render something legible rather
  // than an unstyled pill.
  if (!meta) return <Badge variant="neutral">{humanize(status)}</Badge>;
  const { variant, Icon } = meta;
  return (
    <Badge variant={variant} className="whitespace-nowrap">
      <Icon className="h-3 w-3 shrink-0" /> {t(`status.${status}` as never)}
    </Badge>
  );
}

function ChannelBadge({ channel }: { channel: string }) {
  const t = useTranslations('orders');
  const meta = CHANNEL_META[channel];
  if (!meta) return <Badge variant="outline">{humanize(channel)}</Badge>;
  const { Icon } = meta;
  return (
    <Badge variant="outline">
      <Icon className="h-3 w-3" /> {t(`channel.${channel}` as never)}
    </Badge>
  );
}
