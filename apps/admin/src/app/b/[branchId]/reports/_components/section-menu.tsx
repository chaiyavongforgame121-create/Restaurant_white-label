'use client';

import * as React from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ArrowDown, ArrowUp, Layers, Tag, UtensilsCrossed } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { formatCurrency } from '@favornoms/shared';
import { Kpi } from './kpi';
import { Caption, EmptyNote, SectionFrame } from './section-frame';
import type { MenuReport, SectionResult } from './report-queries';

type ItemSort = 'revenue' | 'quantity' | 'orders' | 'name';

export function SectionMenu({
  result,
  currency,
}: {
  result: SectionResult<MenuReport>;
  currency: string;
}) {
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const [sort, setSort] = React.useState<ItemSort>('revenue');
  const [asc, setAsc] = React.useState(false);

  const items = React.useMemo(() => {
    const rows = [...(data?.by_item ?? [])];
    rows.sort((a, b) => {
      const cmp =
        sort === 'name' ? a.name.localeCompare(b.name) : Number(a[sort]) - Number(b[sort]);
      return asc ? cmp : -cmp;
    });
    return rows;
  }, [data, sort, asc]);

  const toggle = (key: ItemSort) => {
    if (key === sort) {
      setAsc((v) => !v);
      return;
    }
    setSort(key);
    // Names read A→Z; every number reads biggest first, the same rule the customers list uses.
    setAsc(key === 'name');
  };

  return (
    <SectionFrame
      id="menu"
      title="Menu"
      icon={<UtensilsCrossed className="h-5 w-5" />}
      caption="What sold, by dish, category and combo — plus what promotions gave away."
      error={result.error ?? (data ? null : 'No menu payload was returned.')}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<UtensilsCrossed className="h-5 w-5" />}
              label="Items sold"
              value={data.totals.items_sold.toString()}
              hint={`${data.totals.distinct_items} different items`}
            />
            <Kpi
              icon={<Layers className="h-5 w-5" />}
              label="Item revenue"
              value={money(data.totals.item_revenue)}
              hint={`${money(data.totals.modifier_revenue)} from options`}
            />
            <Kpi
              icon={<Layers className="h-5 w-5" />}
              label="Combo revenue"
              value={money(data.totals.combo_revenue)}
              hint="Was missing from By category entirely"
            />
            <Kpi
              icon={<Tag className="h-5 w-5" />}
              label="Promo giveaway"
              value={money(data.totals.promo_discount)}
              hint={`${data.totals.promo_orders} orders used a code`}
              tone="warning"
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Sales by item</h3>
              {items.length === 0 ? (
                <EmptyNote>Nothing sold in this range.</EmptyNote>
              ) : (
                <div className="mt-3 max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <SortHeader label="Item" active={sort === 'name'} asc={asc} onClick={() => toggle('name')} />
                        <SortHeader label="Qty" align="right" active={sort === 'quantity'} asc={asc} onClick={() => toggle('quantity')} />
                        <SortHeader label="Orders" align="right" active={sort === 'orders'} asc={asc} onClick={() => toggle('orders')} />
                        <SortHeader label="Revenue" align="right" active={sort === 'revenue'} asc={asc} onClick={() => toggle('revenue')} />
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((i) => (
                        <tr key={i.name} className="border-t border-border">
                          <td className="max-w-[16rem] truncate py-1.5 pr-2 font-medium">
                            {i.name}
                          </td>
                          <td className="py-1.5 pr-2 text-right tabular-nums">{i.quantity}</td>
                          <td className="py-1.5 pr-2 text-right tabular-nums text-muted-foreground">
                            {i.orders}
                          </td>
                          <td className="py-1.5 text-right font-semibold tabular-nums">
                            {money(i.revenue)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <Caption>Top 100 items by revenue; click a heading to re-sort.</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">By category</h3>
              {data.by_category.length === 0 ? (
                <EmptyNote>No category data.</EmptyNote>
              ) : (
                <div className="mt-3 h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={data.by_category} layout="vertical">
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                        horizontal={false}
                      />
                      <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                      <YAxis
                        type="category"
                        dataKey="category"
                        stroke="hsl(var(--muted-foreground))"
                        fontSize={12}
                        width={110}
                      />
                      <Tooltip
                        contentStyle={{
                          background: 'hsl(var(--card))',
                          border: '1px solid hsl(var(--border))',
                          borderRadius: 12,
                        }}
                        formatter={(v: number) => money(v)}
                      />
                      <Bar dataKey="revenue" fill="hsl(var(--accent))" radius={[0, 8, 8, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <Caption>
                Combos land in their own band now. They used to disappear here, because a
                combo line carries no menu item to join a category on.
              </Caption>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Best-selling combos</h3>
              {data.by_combo.length === 0 ? (
                <EmptyNote>No combo sold in this range.</EmptyNote>
              ) : (
                <ul className="mt-3 space-y-1.5 text-sm">
                  {data.by_combo.map((c, idx) => (
                    <li
                      key={c.combo_id ?? `${c.name}-${idx}`}
                      className="flex items-center justify-between gap-2 rounded-xl bg-muted/40 px-3 py-2"
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-primary/15 text-xs font-bold text-primary">
                          {idx + 1}
                        </span>
                        <span className="truncate font-semibold">{c.name}</span>
                      </span>
                      <span className="shrink-0 text-right">
                        <span className="text-xs text-muted-foreground">{c.quantity}x · </span>
                        <span className="font-semibold tabular-nums">{money(c.revenue)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">Promotions</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <PromoRow label="Orders with a code" value={data.totals.promo_orders.toString()} />
                <PromoRow label="Discount given" value={money(data.totals.promo_discount)} />
                <PromoRow
                  label="Sales those orders brought in"
                  value={money(data.totals.promo_attributed_revenue)}
                />
              </dl>
              {data.by_promo.length === 0 ? (
                <EmptyNote>No promo code was used in this range.</EmptyNote>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-1 font-normal">Code</th>
                      <th className="pb-1 text-right font-normal">Orders</th>
                      <th className="pb-1 text-right font-normal">Given away</th>
                      <th className="pb-1 text-right font-normal">Sales</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.by_promo.map((p) => (
                      <tr key={p.code} className="border-t border-border">
                        <td className="py-1.5 font-mono text-xs uppercase">{p.code}</td>
                        <td className="py-1.5 text-right tabular-nums">{p.orders}</td>
                        <td className="py-1.5 text-right tabular-nums text-warning">
                          {money(p.discount)}
                        </td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">
                          {money(p.gross_subtotal)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <Caption>
                Counted from the code stamped on each order, so a guest who used a code is
                included — the redemption ledger only records signed-in diners.
              </Caption>
            </Card>
          </div>
        </>
      ) : null}
    </SectionFrame>
  );
}

function SortHeader({
  label,
  align = 'left',
  active,
  asc,
  onClick,
}: {
  label: string;
  align?: 'left' | 'right';
  active: boolean;
  asc: boolean;
  onClick: () => void;
}) {
  return (
    <th
      aria-sort={active ? (asc ? 'ascending' : 'descending') : 'none'}
      className={`pb-1 font-normal ${align === 'right' ? 'text-right' : 'text-left'}`}
    >
      <button
        type="button"
        onClick={onClick}
        className={`focus-ring inline-flex items-center gap-1 rounded ${
          active ? 'font-semibold text-foreground' : ''
        }`}
      >
        {label}
        {active ? (
          asc ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : null}
      </button>
    </th>
  );
}

function PromoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
