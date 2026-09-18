'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Ban, Check, ClipboardCheck, Package, Pencil, Plus, RotateCcw, Trash, X } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, formatInZone, isUiLocale } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import { Badge, Button, Card, useConfirm } from '@favornoms/ui';
import {
  DEFAULT_LOW_STOCK_THRESHOLD,
  formatSoldOutUntil,
  inventoryErrorKey,
  nextSoldOutExpiry,
  parseWholeNumber,
  stockState,
  type StockFields,
} from './stock-model';

export interface InventoryItem extends StockFields {
  id: string;
  name: string;
  image_url: string | null;
  price: number | string;
  track_stock: boolean;
  is_active: boolean;
}

/** A row of v_low_stock_items: an active dish that is low, 86'd, or sold out. */
export interface InventoryAlert extends StockFields {
  id: string;
  name: string;
  is_low_stock: boolean | null;
  is_86: boolean | null;
  is_sold_out: boolean | null;
}

interface LogEntry {
  id: string;
  menu_item_id: string;
  created_at: string;
}

export interface Restock extends LogEntry {
  delta: number;
  cost_per_unit: number | string | null;
  supplier: string | null;
  notes: string | null;
}

export interface Waste extends LogEntry {
  quantity: number;
  reason: string;
  notes: string | null;
}

export interface StockCount extends LogEntry {
  counted_qty: number;
  previous_qty: number | null;
  notes: string | null;
}

interface Props {
  branchId: string;
  /** branches.timezone: every time on this page is the shop's clock, not the device's. */
  timezone: string;
  /** branches.settings.currency. */
  currency: string;
  /** One of the page's reads failed; what did load is still shown. */
  loadFailed: boolean;
  items: InventoryItem[];
  alerts: InventoryAlert[];
  restocks: Restock[];
  waste: Waste[];
  counts: StockCount[];
}

/** set_stock's answer. */
interface CountResult {
  previous_qty: number | null;
  stock_quantity: number;
  cleared_86: boolean;
}

/** Stored in waste_log.reason — the values stay English; only the label is translated. */
const WASTE_REASONS = ['expired', 'spoiled', 'spilled', 'damaged', 'staff_meal', 'other'];

const WASTE_REASON_KEYS: Record<string, string> = {
  expired: 'expired',
  spoiled: 'spoiled',
  spilled: 'spilled',
  damaged: 'damaged',
  staff_meal: 'staffMeal',
  other: 'other',
};

/** setTimeout's ceiling; a later 86 expiry is picked up by the next refresh instead. */
const MAX_TIMER_MS = 2_147_483_647;

function useWasteReasonLabel() {
  const t = useTranslations('inventory.reasons');
  // A reason written by something older than this list is shown as it was stored.
  return (reason: string) => {
    const key = WASTE_REASON_KEYS[reason];
    return key ? t(key) : reason.replace('_', ' ');
  };
}

/** The translated sentence for a failed write; the raw error goes to the console. */
function useErrorText() {
  const t = useTranslations('inventory');
  return (context: string, err: { code?: string; message?: string }) => {
    console.error(`[inventory] ${context} failed`, err);
    return t(`errors.${inventoryErrorKey(err)}`);
  };
}

/** Re-read one dish after a write, so the notice can say what the shelf holds now. */
async function readStock(itemId: string): Promise<StockFields | null> {
  const { data } = await getBrowserClient()
    .from('menu_items')
    .select('track_stock, stock_quantity, low_stock_threshold, sold_out_until')
    .eq('id', itemId)
    .maybeSingle();
  return data ?? null;
}

export function InventoryView({ branchId, timezone, currency, loadFailed, items, alerts, restocks, waste, counts }: Props) {
  const t = useTranslations('inventory');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const reasonLabel = useWasteReasonLabel();
  const errorText = useErrorText();
  const confirm = useConfirm();
  const router = useRouter();
  const [restockOpen, setRestockOpen] = React.useState<InventoryItem | null>(null);
  const [wasteOpen, setWasteOpen] = React.useState<InventoryItem | null>(null);
  const [countOpen, setCountOpen] = React.useState<{ item: InventoryItem; start: boolean } | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [savingIds, setSavingIds] = React.useState<string[]>([]);
  const [pendingTracking, setPendingTracking] = React.useState<Record<string, boolean>>({});
  const errorRef = React.useRef<HTMLDivElement | null>(null);

  const until = (iso: string) => formatSoldOutUntil(iso, timezone, locale);
  const when = (iso: string) => formatInZone(iso, timezone, {}, locale);
  const nowMs = Date.now();

  // Sales, the kitchen's 86 and other screens all move these rows while the page is open.
  const { healthy } = useRealtime({
    channel: `inventory:${branchId}`,
    tables: [{ table: 'menu_items', filter: `branch_id=eq.${branchId}` }],
    refetch: () => router.refresh(),
  });

  // Nothing is written when an 86 runs out, so no change event announces it. Refresh at that
  // moment, or the dish would sit under "Sold out" after it went back on sale by itself.
  React.useEffect(() => {
    const next = nextSoldOutExpiry(items);
    if (next === null) return;
    const delay = Math.min(Math.max(next - Date.now() + 1000, 1000), MAX_TIMER_MS);
    const timer = window.setTimeout(() => router.refresh(), delay);
    return () => window.clearTimeout(timer);
  }, [items, router]);

  const activeItems = items.filter((i) => i.is_active);
  const trackedCount = activeItems.filter((i) => i.track_stock).length;
  // Two lists, because they ask for different things: a sold-out dish needs putting back on sale
  // (or restocking), a low one needs ordering. One "Low stock" list used to hold a dish with 29
  // on the shelf and an untracked dish printed as "{blank} left".
  const soldOutAlerts = alerts.filter((a) => a.is_sold_out);
  const lowAlerts = alerts.filter((a) => a.is_low_stock && !a.is_sold_out);

  const itemById = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  // The banner sits above a table that runs for pages on a real menu, so the merchant who
  // clicked a checkbox near the bottom had already scrolled past the only place the
  // rejection was reported — which is most of why this read as a dead control.
  React.useEffect(() => {
    if (error) errorRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [error]);

  // A confirmation should not sit there all shift.
  React.useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 8000);
    return () => clearTimeout(timer);
  }, [notice]);

  // The checkbox is bound straight to the server row and router.refresh() is a round-trip,
  // so between the click and the repaint the box would show the old value again. Hold the
  // merchant's choice until the refreshed row agrees with it, or the item is gone.
  React.useEffect(() => {
    setPendingTracking((cur) => {
      const next: Record<string, boolean> = {};
      for (const [id, on] of Object.entries(cur)) {
        const row = itemById.get(id);
        if (row && row.track_stock !== on) next[id] = on;
      }
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    });
  }, [itemById]);

  const succeed = (message: string) => {
    setError(null);
    setNotice(message);
    router.refresh();
  };

  const fail = (message: string) => {
    setNotice(null);
    setError(message);
  };

  const withSaving = async (id: string, work: () => Promise<void>) => {
    setSavingIds((cur) => [...cur, id]);
    try {
      await work();
    } finally {
      setSavingIds((cur) => cur.filter((x) => x !== id));
    }
  };

  const onTrackingChange = (item: InventoryItem, on: boolean) => {
    // Switching tracking on asks how many there are. It used to start silently at 0, which made
    // the dish sold out on the storefront the moment the box was ticked.
    if (on) {
      setCountOpen({ item, start: true });
      return;
    }
    void withSaving(item.id, async () => {
      setPendingTracking((cur) => ({ ...cur, [item.id]: false }));
      const { data, error: upErr } = await getBrowserClient()
        .from('menu_items')
        // A tracked dish always has a count and an untracked one has none
        // (menu_items_tracked_stock_has_count). low_stock_threshold is NOT NULL: keep the
        // merchant's own, so re-ticking restores the level they chose.
        .update({ track_stock: false, stock_quantity: null })
        .eq('id', item.id)
        // An update that matches no row — the item was deleted, or RLS refused the write —
        // comes back 204 with no error, which is indistinguishable from a save that worked.
        .select('id')
        .maybeSingle();
      if (upErr || !data) {
        setPendingTracking((cur) => {
          const next = { ...cur };
          delete next[item.id];
          return next;
        });
        fail(
          upErr
            ? t('tracking.failed', { name: item.name, reason: errorText('switch tracking off', upErr) })
            : t('tracking.notSaved', { name: item.name }),
        );
        return;
      }
      succeed(t('tracking.off', { name: item.name }));
    });
  };

  const markSoldOut = async (item: InventoryItem) => {
    if (
      !(await confirm({
        title: t('markSoldOutConfirm.title', { name: item.name }),
        body: t('markSoldOutConfirm.body'),
        confirmLabel: t('markSoldOutConfirm.confirm'),
      }))
    ) {
      return;
    }
    await withSaving(item.id, async () => {
      const { data, error: rpcErr } = await getBrowserClient().rpc('set_item_86', {
        p_menu_item_id: item.id,
        p_sold_out: true,
      });
      if (rpcErr) {
        fail(t('soldOutFailed', { name: item.name, reason: errorText('set_item_86', rpcErr) }));
        return;
      }
      const lifts = (data as { sold_out_until?: string | null } | null)?.sold_out_until;
      succeed(
        lifts
          ? t('notices.markedSoldOut', { name: item.name, time: until(lifts) })
          : t('notices.markedSoldOutNoTime', { name: item.name }),
      );
    });
  };

  const backOnSale = async (item: { id: string; name: string }) => {
    await withSaving(item.id, async () => {
      const { error: rpcErr } = await getBrowserClient().rpc('set_item_86', {
        p_menu_item_id: item.id,
        p_sold_out: false,
      });
      if (rpcErr) {
        fail(t('soldOutFailed', { name: item.name, reason: errorText('set_item_86', rpcErr) }));
        return;
      }
      const after = await readStock(item.id);
      // Lifting the 86 does not conjure stock: a counted dish at 0 is still sold out.
      succeed(
        after && stockState(after).isSoldOut
          ? t('notices.backOnSaleEmpty', { name: item.name })
          : t('notices.backOnSaleNow', { name: item.name }),
      );
    });
  };

  const saveThreshold = async (item: InventoryItem, threshold: number): Promise<boolean> => {
    let ok = false;
    await withSaving(item.id, async () => {
      const { data, error: upErr } = await getBrowserClient()
        .from('menu_items')
        .update({ low_stock_threshold: threshold })
        .eq('id', item.id)
        .select('id')
        .maybeSingle();
      if (upErr || !data) {
        fail(
          upErr
            ? t('thresholdFailed', { name: item.name, reason: errorText('save threshold', upErr) })
            : t('tracking.notSaved', { name: item.name }),
        );
        return;
      }
      ok = true;
      succeed(t('notices.thresholdSaved', { name: item.name, threshold }));
    });
    return ok;
  };

  const afterRestock = async (item: InventoryItem, delta: number) => {
    setRestockOpen(null);
    const before = stockState(item);
    const after = await readStock(item.id);
    const afterState = after ? stockState(after) : null;
    const count = afterState?.count ?? (before.count ?? 0) + delta;
    const parts = [t('notices.restocked', { name: item.name, delta, count })];
    // The complaint this page collected: the restock landed, the dish stayed "Out of stock",
    // and nothing on screen said either way.
    if (before.isSoldOut && afterState && !afterState.isSoldOut) parts.push(t('notices.backOnSale'));
    succeed(parts.join(' '));
  };

  const afterWaste = async (item: InventoryItem, quantity: number) => {
    setWasteOpen(null);
    const before = stockState(item);
    const after = await readStock(item.id);
    const afterState = after ? stockState(after) : null;
    const count = afterState?.count ?? Math.max(0, (before.count ?? 0) - quantity);
    const parts = [t('notices.wasted', { name: item.name, quantity, count })];
    if (!before.isSoldOut && count <= 0) parts.push(t('notices.nowSoldOut'));
    succeed(parts.join(' '));
  };

  const afterCount = (item: InventoryItem, start: boolean, result: CountResult) => {
    setCountOpen(null);
    const count = result.stock_quantity;
    if (start) {
      succeed(
        count > 0
          ? t('tracking.on', { name: item.name, count })
          : t('tracking.onEmpty', { name: item.name }),
      );
      return;
    }
    const parts = [
      result.previous_qty == null
        ? t('notices.countedFirst', { name: item.name, count })
        : t('notices.counted', { name: item.name, count, previous: result.previous_qty }),
    ];
    const before = stockState(item);
    if (before.isSoldOut && count > 0) parts.push(t('notices.backOnSale'));
    else if (!before.isSoldOut && count <= 0) parts.push(t('notices.nowSoldOut'));
    succeed(parts.join(' '));
  };

  const openRestock = (id: string) => {
    const it = itemById.get(id);
    if (it) setRestockOpen(it);
  };

  return (
    <div className="container max-w-6xl py-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3 px-2 pl-16 lg:px-0">
        <div>
          <h1 className="font-display text-3xl font-bold">{t('title')}</h1>
          <p className="mt-1 text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Stat label={t('stats.tracked')} value={String(trackedCount)} />
          <Stat
            label={t('stats.soldOut')}
            value={String(soldOutAlerts.length)}
            tone={soldOutAlerts.length > 0 ? 'danger' : 'muted'}
          />
          <Stat
            label={t('stats.lowStock')}
            value={String(lowAlerts.length)}
            tone={lowAlerts.length > 0 ? 'warning' : 'muted'}
          />
        </div>
      </header>

      {loadFailed && (
        <div role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {t('loadFailed')}
        </div>
      )}

      {!healthy && (
        <div role="status" className="mb-4 rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
          {t('liveOff')}
        </div>
      )}

      {error && (
        <div ref={errorRef} role="alert" className="mb-4 rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">{error}</div>
      )}

      {notice && (
        <div role="status" className="mb-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">{notice}</div>
      )}

      {soldOutAlerts.length > 0 && (
        <Card className="mb-4 border-danger/40 bg-danger/5 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Ban className="h-5 w-5 text-danger" /> {t('alerts.soldOutTitle')}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{t('alerts.soldOutHint')}</p>
          <ul className="mt-3 space-y-2">
            {soldOutAlerts.map((a) => {
              const st = stockState(a, nowMs);
              const busy = savingIds.includes(a.id);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm">
                  <span>
                    <strong>{a.name}</strong>
                    <span className="ml-2 text-muted-foreground">
                      {st.soldOutUntil
                        ? st.count !== null
                          ? t('alerts.untilWithCount', { time: until(st.soldOutUntil), count: st.count })
                          : t('alerts.until', { time: until(st.soldOutUntil) })
                        : t('alerts.noneLeft')}
                    </span>
                  </span>
                  {st.soldOutUntil ? (
                    <Button
                      size="sm"
                      variant="gradient"
                      loading={busy}
                      onClick={() => void backOnSale(a)}
                      leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                    >
                      {t('actions.backOnSale')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      variant="gradient"
                      onClick={() => openRestock(a.id)}
                      leftIcon={<Plus className="h-3.5 w-3.5" />}
                    >
                      {t('actions.restock')}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {lowAlerts.length > 0 && (
        <Card className="mb-6 border-warning/40 bg-warning/5 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <AlertTriangle className="h-5 w-5 text-warning" /> {t('alerts.lowTitle')}
          </h2>
          <ul className="mt-3 space-y-2">
            {lowAlerts.map((a) => {
              const st = stockState(a, nowMs);
              return (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-card p-3 text-sm">
                  <span>
                    <strong>{a.name}</strong>
                    <span className="ml-2 text-muted-foreground">
                      {t('alerts.lowDetail', { left: st.count ?? 0, threshold: st.threshold })}
                    </span>
                  </span>
                  <Button
                    size="sm"
                    variant="gradient"
                    onClick={() => openRestock(a.id)}
                    leftIcon={<Plus className="h-3.5 w-3.5" />}
                  >
                    {t('actions.restock')}
                  </Button>
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      <Card className="mb-6 overflow-hidden">
        <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-sm">
          <thead className="bg-muted/50 text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-5 py-3">{t('table.item')}</th>
              <th className="px-5 py-3 text-center">{t('table.trackStock')}</th>
              <th className="px-5 py-3 text-right">{t('table.stock')}</th>
              <th className="px-5 py-3 text-right">{t('table.threshold')}</th>
              <th className="px-5 py-3 text-right">
                <span className="sr-only">{t('table.actions')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((it) => {
              const st = stockState(it, nowMs);
              const busy = savingIds.includes(it.id);
              return (
                <tr key={it.id} className={`border-t border-border/40 ${it.is_active ? '' : 'opacity-60'}`}>
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      {it.image_url ? (
                        <span
                          className="h-10 w-10 shrink-0 rounded-lg bg-muted bg-cover bg-center"
                          style={{ backgroundImage: `url(${it.image_url})` }}
                        />
                      ) : (
                        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-lg bg-muted">
                          <Package className="h-4 w-4 text-muted-foreground" />
                        </span>
                      )}
                      <div className="min-w-0">
                        <p className="font-medium">{it.name}</p>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <span className="text-xs text-muted-foreground">{formatCurrency(Number(it.price), currency)}</span>
                          {!it.is_active && (
                            <Badge variant="muted" title={t('status.hiddenHint')}>{t('status.hidden')}</Badge>
                          )}
                          {st.soldOutUntil ? (
                            <Badge variant="danger">{t('status.soldOutUntil', { time: until(st.soldOutUntil) })}</Badge>
                          ) : st.isSoldOut ? (
                            <Badge variant="danger">{t('status.soldOut')}</Badge>
                          ) : st.isLow ? (
                            <Badge variant="warning">{t('status.low')}</Badge>
                          ) : null}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-center">
                    <input
                      type="checkbox"
                      checked={pendingTracking[it.id] ?? it.track_stock}
                      disabled={busy}
                      onChange={(e) => onTrackingChange(it, e.target.checked)}
                      aria-label={t('table.trackStockFor', { name: it.name })}
                      className="h-4 w-4 accent-primary disabled:opacity-50"
                    />
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums">
                    {st.count !== null ? st.count : '—'}
                  </td>
                  <td className="px-5 py-3 text-right tabular-nums text-muted-foreground">
                    {st.tracked ? (
                      <ThresholdCell
                        name={it.name}
                        value={st.threshold}
                        disabled={busy}
                        onSave={(n) => saveThreshold(it, n)}
                      />
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-5 py-3 text-right">
                    <div className="inline-flex flex-wrap justify-end gap-1">
                      {st.tracked && (
                        <>
                          <Button size="sm" variant="ghost" onClick={() => setRestockOpen(it)} leftIcon={<Plus className="h-3.5 w-3.5" />}>
                            {t('actions.restock')}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => setWasteOpen(it)} leftIcon={<Trash className="h-3.5 w-3.5" />}>
                            {t('actions.waste')}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setCountOpen({ item: it, start: false })}
                            leftIcon={<ClipboardCheck className="h-3.5 w-3.5" />}
                          >
                            {t('actions.count')}
                          </Button>
                        </>
                      )}
                      {/* Works whether or not the dish is counted: an 86 is the only way to take
                          an uncounted dish off sale for the rest of the day. */}
                      {st.soldOutUntil ? (
                        <Button
                          size="sm"
                          variant="soft"
                          loading={busy}
                          onClick={() => void backOnSale(it)}
                          leftIcon={<RotateCcw className="h-3.5 w-3.5" />}
                        >
                          {t('actions.backOnSale')}
                        </Button>
                      ) : it.is_active ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => void markSoldOut(it)}
                          leftIcon={<Ban className="h-3.5 w-3.5" />}
                        >
                          {t('actions.markSoldOut')}
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table></div>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('restocks.title')}</h2>
          {restocks.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('restocks.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {restocks.slice(0, 10).map((r) => {
                const it = itemById.get(r.menu_item_id);
                return (
                  <li key={r.id} className="flex items-start justify-between gap-2 border-b border-border/40 pb-2 last:border-0">
                    <span className="min-w-0">
                      <strong>+{r.delta}</strong>{' '}
                      <span className="text-muted-foreground">{it?.name ?? '?'}</span>
                      {r.supplier && <span className="text-xs text-muted-foreground"> · {r.supplier}</span>}
                      {r.cost_per_unit != null && (
                        <span className="text-xs text-muted-foreground">
                          {' · '}
                          {t('restocks.costEach', { cost: formatCurrency(Number(r.cost_per_unit), currency) })}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{when(r.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('waste.title')}</h2>
          {waste.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('waste.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {waste.slice(0, 10).map((w) => {
                const it = itemById.get(w.menu_item_id);
                return (
                  <li key={w.id} className="flex items-start justify-between gap-2 border-b border-border/40 pb-2 last:border-0">
                    <span className="min-w-0">
                      <strong>-{w.quantity}</strong>{' '}
                      <span className="text-muted-foreground">{it?.name ?? '?'}</span>
                      {' · '}
                      <Badge variant="muted">{reasonLabel(w.reason)}</Badge>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{when(w.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('counts.title')}</h2>
          {counts.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">{t('counts.empty')}</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {counts.slice(0, 10).map((c) => {
                const it = itemById.get(c.menu_item_id);
                return (
                  <li key={c.id} className="flex items-start justify-between gap-2 border-b border-border/40 pb-2 last:border-0">
                    <span className="min-w-0">
                      <strong className="tabular-nums">
                        {c.previous_qty == null
                          ? t('counts.entryFirst', { count: c.counted_qty })
                          : t('counts.entry', { previous: c.previous_qty, count: c.counted_qty })}
                      </strong>{' '}
                      <span className="text-muted-foreground">{it?.name ?? '?'}</span>
                      {c.notes && <span className="text-xs text-muted-foreground"> · {c.notes}</span>}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{when(c.created_at)}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>

      {restockOpen && (
        <RestockDialog
          branchId={branchId}
          item={restockOpen}
          currency={currency}
          soldOutUntilText={(() => {
            const s = stockState(restockOpen).soldOutUntil;
            return s ? until(s) : null;
          })()}
          onClose={() => setRestockOpen(null)}
          onSaved={(delta) => void afterRestock(restockOpen, delta)}
        />
      )}
      {wasteOpen && (
        <WasteDialog
          branchId={branchId}
          item={wasteOpen}
          onClose={() => setWasteOpen(null)}
          onSaved={(quantity) => void afterWaste(wasteOpen, quantity)}
        />
      )}
      {countOpen && (
        <CountDialog
          item={countOpen.item}
          start={countOpen.start}
          onClose={() => setCountOpen(null)}
          onSaved={(result) => afterCount(countOpen.item, countOpen.start, result)}
        />
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warning' | 'danger' | 'muted' }) {
  const bg = tone === 'warning' ? 'bg-warning/10' : tone === 'danger' ? 'bg-danger/10' : 'bg-muted/40';
  return (
    <div className={`rounded-2xl px-4 py-2 text-center ${bg}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-display text-xl font-bold">{value}</p>
    </div>
  );
}

/** The alert level, edited where it is read instead of only in the menu editor. */
function ThresholdCell({
  name,
  value,
  disabled,
  onSave,
}: {
  name: string;
  value: number;
  disabled: boolean;
  onSave: (n: number) => Promise<boolean>;
}) {
  const t = useTranslations('inventory');
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(String(value));
  const [invalid, setInvalid] = React.useState(false);

  const start = () => {
    setDraft(String(value));
    setInvalid(false);
    setEditing(true);
  };

  const save = async () => {
    const n = parseWholeNumber(draft, 0);
    if (n === null) {
      setInvalid(true);
      return;
    }
    if (n === value) {
      setEditing(false);
      return;
    }
    if (await onSave(n)) setEditing(false);
  };

  if (!editing) {
    return (
      <button
        type="button"
        onClick={start}
        disabled={disabled}
        aria-label={t('actions.editThreshold', { name })}
        className="focus-ring inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-muted disabled:opacity-50"
      >
        {value}
        <Pencil className="h-3 w-3" aria-hidden />
      </button>
    );
  }

  return (
    <form
      className="inline-flex items-center gap-1"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        autoFocus
        value={draft}
        inputMode="numeric"
        aria-label={t('actions.editThreshold', { name })}
        aria-invalid={invalid}
        title={invalid ? t('errors.wholeCount') : undefined}
        onChange={(e) => {
          setDraft(e.target.value);
          setInvalid(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
        className={`input h-9 min-h-0 w-20 px-2 text-right text-sm ${invalid ? 'border-danger' : ''}`}
      />
      <button
        type="submit"
        disabled={disabled}
        aria-label={t('actions.saveThreshold')}
        className="focus-ring grid h-8 w-8 place-items-center rounded-md text-success hover:bg-success/10 disabled:opacity-50"
      >
        <Check className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => setEditing(false)}
        aria-label={t('actions.cancelThreshold')}
        className="focus-ring grid h-8 w-8 place-items-center rounded-md hover:bg-muted"
      >
        <X className="h-4 w-4" />
      </button>
    </form>
  );
}

function RestockDialog({
  branchId,
  item,
  currency,
  soldOutUntilText,
  onClose,
  onSaved,
}: {
  branchId: string;
  item: InventoryItem;
  currency: string;
  /** Set when the dish is 86'd: the restock lifts it, and the dialog says so. */
  soldOutUntilText: string | null;
  onClose: () => void;
  onSaved: (delta: number) => void;
}) {
  const t = useTranslations('inventory');
  const errorText = useErrorText();
  const [delta, setDelta] = React.useState('10');
  const [cost, setCost] = React.useState('');
  const [supplier, setSupplier] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const d = parseWholeNumber(delta, 1);
    if (d === null) { setError(t('errors.wholeQuantity')); return; }
    const c = cost.trim() === '' ? null : Number(cost);
    if (c !== null && (!Number.isFinite(c) || c < 0)) { setError(t('errors.costInvalid')); return; }
    setBusy(true);
    setError(null);
    const { error: insErr } = await getBrowserClient().from('restock_log').insert({
      branch_id: branchId,
      menu_item_id: item.id,
      delta: d,
      cost_per_unit: c,
      supplier: supplier.trim() || null,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (insErr) {
      setError(errorText('restock', insErr));
      return;
    }
    onSaved(d);
  };

  return (
    <ModalShell title={t('restockDialog.title', { name: item.name })} onClose={onClose} onSubmit={submit}>
      <p className="text-sm text-muted-foreground">
        {t('restockDialog.inStock', { count: item.stock_quantity ?? 0 })}
      </p>
      {soldOutUntilText && (
        <p className="rounded-lg bg-info/10 px-3 py-2 text-sm text-info">
          {t('restockDialog.clears86', { time: soldOutUntilText })}
        </p>
      )}
      <Field label={t('restockDialog.quantity')}>
        <input autoFocus type="number" min={1} step={1} inputMode="numeric" value={delta} onChange={(e) => setDelta(e.target.value)} className="input" />
      </Field>
      <Field label={t('restockDialog.cost', { currency })}>
        <input type="number" min={0} step="0.01" inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} className="input" />
      </Field>
      <Field label={t('restockDialog.supplier')}>
        <input value={supplier} onChange={(e) => setSupplier(e.target.value)} className="input" />
      </Field>
      <Field label={t('restockDialog.notes')}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" />
      </Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t('restockDialog.cancel')}</Button>
        <Button type="submit" variant="gradient" loading={busy}>{t('restockDialog.submit')}</Button>
      </div>
    </ModalShell>
  );
}

function WasteDialog({
  branchId,
  item,
  onClose,
  onSaved,
}: {
  branchId: string;
  item: InventoryItem;
  onClose: () => void;
  onSaved: (quantity: number) => void;
}) {
  const t = useTranslations('inventory');
  const reasonLabel = useWasteReasonLabel();
  const errorText = useErrorText();
  const [qty, setQty] = React.useState('1');
  const [reason, setReason] = React.useState('expired');
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const q = parseWholeNumber(qty, 1);
    if (q === null) { setError(t('errors.wholeQuantity')); return; }
    setBusy(true);
    setError(null);
    const { error: insErr } = await getBrowserClient().from('waste_log').insert({
      branch_id: branchId,
      menu_item_id: item.id,
      quantity: q,
      reason,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (insErr) {
      setError(errorText('waste log', insErr));
      return;
    }
    onSaved(q);
  };

  return (
    <ModalShell title={t('wasteDialog.title', { name: item.name })} onClose={onClose} onSubmit={submit}>
      <p className="text-sm text-muted-foreground">
        {t('wasteDialog.inStock', { count: item.stock_quantity ?? 0 })}
      </p>
      <Field label={t('wasteDialog.quantity')}>
        <input autoFocus type="number" min={1} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="input" />
      </Field>
      <Field label={t('wasteDialog.reason')}>
        <select value={reason} onChange={(e) => setReason(e.target.value)} className="input">
          {WASTE_REASONS.map((r) => <option key={r} value={r}>{reasonLabel(r)}</option>)}
        </select>
      </Field>
      <Field label={t('wasteDialog.notes')}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" />
      </Field>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t('wasteDialog.cancel')}</Button>
        <Button type="submit" variant="gradient" loading={busy}>{t('wasteDialog.submit')}</Button>
      </div>
    </ModalShell>
  );
}

/**
 * A stock-take ("Set count"), or the starting count when Track stock is ticked. Both go through
 * set_stock, which replaces the count, logs it in stock_count_log with the previous figure and,
 * above 0, lifts a kitchen 86.
 */
function CountDialog({
  item,
  start,
  onClose,
  onSaved,
}: {
  item: InventoryItem;
  start: boolean;
  onClose: () => void;
  onSaved: (result: CountResult) => void;
}) {
  const t = useTranslations('inventory');
  const errorText = useErrorText();
  const [qty, setQty] = React.useState(start ? '' : String(item.stock_quantity ?? 0));
  const [notes, setNotes] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    const n = parseWholeNumber(qty, 0);
    if (n === null) { setError(t('errors.wholeCount')); return; }
    setBusy(true);
    setError(null);
    const { data, error: rpcErr } = await getBrowserClient().rpc('set_stock', {
      p_menu_item_id: item.id,
      p_counted_qty: n,
      ...(notes.trim() ? { p_notes: notes.trim() } : {}),
    });
    setBusy(false);
    if (rpcErr) {
      setError(errorText('set_stock', rpcErr));
      return;
    }
    const res = (data ?? {}) as Partial<CountResult>;
    onSaved({
      previous_qty: res.previous_qty ?? null,
      stock_quantity: res.stock_quantity ?? n,
      cleared_86: res.cleared_86 === true,
    });
  };

  return (
    <ModalShell
      title={start ? t('countDialog.startTitle', { name: item.name }) : t('countDialog.title', { name: item.name })}
      onClose={onClose}
      onSubmit={submit}
    >
      <p className="text-sm text-muted-foreground">
        {start ? t('countDialog.startHint') : t('countDialog.hint', { count: item.stock_quantity ?? 0 })}
      </p>
      <Field label={t('countDialog.quantity')}>
        <input autoFocus type="number" min={0} step={1} inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value)} className="input" />
      </Field>
      <Field label={t('countDialog.notes')}>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="input" />
      </Field>
      <p className="text-xs text-muted-foreground">{t('countDialog.clears86')}</p>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 pt-2">
        <Button type="button" variant="ghost" onClick={onClose}>{t('countDialog.cancel')}</Button>
        <Button type="submit" variant="gradient" loading={busy}>
          {start ? t('countDialog.startSubmit') : t('countDialog.submit')}
        </Button>
      </div>
    </ModalShell>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

/**
 * The fields inside use the global `input` class (packages/ui globals.css). They used to carry a
 * `modal-input` class defined in a <style jsx> block here, and a non-global styled-jsx rule only
 * reaches the component's own elements: the inputs are rendered by the dialogs, so they came out
 * as bare, borderless text on the page.
 */
function ModalShell({
  title,
  children,
  onClose,
  onSubmit,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  onSubmit: () => void | Promise<void>;
}) {
  const titleId = React.useId();

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <Card
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-[90vh] w-full max-w-md overflow-y-auto p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onSubmit();
          }}
        >
          <h2 id={titleId} className="font-display text-lg font-semibold">{title}</h2>
          {children}
        </form>
      </Card>
    </div>
  );
}
