'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
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
  const t = useTranslations('reports.menu');
  const data = result.data;
  const money = (n: number) => formatCurrency(n, currency);
  const [sort, setSort] = React.useState<ItemSort>('revenue');
  const [asc, setAsc] = React.useState(false);

  // get_branch_menu_report flags the two bands it names itself when a line has no category to
  // join on. Every other category name is the merchant's and is shown exactly as typed, even one
  // called "Combos".
  const categoryRows = (data?.by_category ?? []).map((c) => ({
    ...c,
    label:
      c.band === 'combos'
        ? t('categoryBand.Combos')
        : c.band === 'uncategorised'
          ? t('categoryBand.Uncategorised')
          : c.category,
  }));

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
      title={t('title')}
      icon={<UtensilsCrossed className="h-5 w-5" />}
      caption={t('caption')}
      error={result.error ?? (data ? null : { code: 'emptyResponse', ref: null })}
    >
      {data ? (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              icon={<UtensilsCrossed className="h-5 w-5" />}
              label={t('itemsSold')}
              value={data.totals.items_sold.toString()}
              hint={t('itemsSoldHint', { count: data.totals.distinct_items })}
            />
            <Kpi
              icon={<Layers className="h-5 w-5" />}
              label={t('itemRevenue')}
              value={money(data.totals.item_revenue)}
              hint={t('itemRevenueHint', { amount: money(data.totals.modifier_revenue) })}
            />
            <Kpi
              icon={<Layers className="h-5 w-5" />}
              label={t('comboRevenue')}
              value={money(data.totals.combo_revenue)}
              hint={t('comboRevenueHint')}
            />
            <Kpi
              icon={<Tag className="h-5 w-5" />}
              label={t('promoGiveaway')}
              value={money(data.totals.promo_discount)}
              hint={t('promoGiveawayHint', { count: data.totals.promo_orders })}
              tone="warning"
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('byItem')}</h3>
              {items.length === 0 ? (
                <EmptyNote>{t('byItemEmpty')}</EmptyNote>
              ) : (
                <div className="mt-3 max-h-96 overflow-auto">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-card">
                      <tr className="text-left text-xs text-muted-foreground">
                        <SortHeader label={t('col.item')} active={sort === 'name'} asc={asc} onClick={() => toggle('name')} />
                        <SortHeader label={t('col.qty')} align="right" active={sort === 'quantity'} asc={asc} onClick={() => toggle('quantity')} />
                        <SortHeader label={t('col.orders')} align="right" active={sort === 'orders'} asc={asc} onClick={() => toggle('orders')} />
                        <SortHeader label={t('col.revenue')} align="right" active={sort === 'revenue'} asc={asc} onClick={() => toggle('revenue')} />
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
              <Caption>{t('byItemCaption')}</Caption>
            </Card>

            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('byCategory')}</h3>
              {data.by_category.length === 0 ? (
                <EmptyNote>{t('byCategoryEmpty')}</EmptyNote>
              ) : (
                <div className="mt-3 h-72">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={categoryRows} layout="vertical">
                      <CartesianGrid
                        strokeDasharray="3 3"
                        stroke="hsl(var(--border))"
                        horizontal={false}
                      />
                      <XAxis type="number" stroke="hsl(var(--muted-foreground))" fontSize={12} />
                      <YAxis
                        type="category"
                        dataKey="label"
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
                      <Bar
                        dataKey="revenue"
                        name={t('col.revenue')}
                        fill="hsl(var(--accent))"
                        radius={[0, 8, 8, 0]}
                      />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
              <Caption>{t('byCategoryCaption')}</Caption>
            </Card>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <Card className="p-5">
              <h3 className="font-display text-lg font-semibold">{t('topCombos')}</h3>
              {data.by_combo.length === 0 ? (
                <EmptyNote>{t('topCombosEmpty')}</EmptyNote>
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
              <h3 className="font-display text-lg font-semibold">{t('promotions')}</h3>
              <dl className="mt-3 space-y-1.5 text-sm">
                <PromoRow label={t('ordersWithCode')} value={data.totals.promo_orders.toString()} />
                <PromoRow label={t('discountGiven')} value={money(data.totals.promo_discount)} />
                <PromoRow
                  label={t('promoSales')}
                  value={money(data.totals.promo_attributed_revenue)}
                />
              </dl>
              {data.by_promo.length === 0 ? (
                <EmptyNote>{t('promosEmpty')}</EmptyNote>
              ) : (
                <table className="mt-3 w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-muted-foreground">
                      <th className="pb-1 font-normal">{t('col.code')}</th>
                      <th className="pb-1 text-right font-normal">{t('col.orders')}</th>
                      <th className="pb-1 text-right font-normal">{t('col.givenAway')}</th>
                      <th className="pb-1 text-right font-normal">{t('col.sales')}</th>
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
              <Caption>{t('promosCaption')}</Caption>
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
