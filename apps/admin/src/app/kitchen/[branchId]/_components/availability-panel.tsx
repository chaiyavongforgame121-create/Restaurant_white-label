'use client';

import * as React from 'react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Ban, ListChecks, Loader2, RotateCcw, Search, X } from 'lucide-react';

import { SUN } from './kitchen-theme';
import {
  AVAILABILITY_FILTERS, availabilityCounts, availabilityGroups, stockBadge,
  type AvailabilityFilter, type AvailabilityItem, type SoldOutItem,
} from './kitchen-model';

/**
 * Every dish on the menu, with the way to mark it sold out or back on sale.
 *
 * The board could only 86 a dish from the ⋮ menu of a ticket that held it, so a dish nobody had
 * ordered yet (the fryer is down, the fish never came) could not be taken off sale from the
 * kitchen at all: the back office's menu needs backoffice.access, which the kitchen role lacks.
 * set_item_86 already lets kitchen.access do it for any dish of the branch; this lists them all.
 *
 * Stock counts are shown, not changed: a counted dish at or under its alert threshold says "Low",
 * one with nothing left says "None left". Counting and restocking stay with Inventory
 * (inventory.manage), and "Back on sale" cannot bring back a dish that has run out of stock.
 *
 * Whether a dish is 86'd comes from the board's own sold-out strip (`soldOut`), so the strip, the
 * ticket menus and this list always agree, and a change made on another tablet shows here too.
 */
export function AvailabilityPanel({
  items,
  loadFailed,
  onRetry,
  soldOut,
  fmtUntil,
  onSoldOut,
  onBackOnSale,
  onClose,
}: {
  /** null while the first read is in flight. */
  items: AvailabilityItem[] | null;
  loadFailed: boolean;
  onRetry: () => void;
  /** The 86'd dishes still in force. */
  soldOut: SoldOutItem[];
  /** "Sold out until" time in the branch's clock. */
  fmtUntil: (iso: string) => string;
  onSoldOut: (item: { id: string; name: string }) => Promise<void>;
  onBackOnSale: (item: { id: string; name: string }) => Promise<void>;
  onClose: () => void;
}) {
  const t = useTranslations('kitchen');
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState<AvailabilityFilter>('all');
  // Dishes with a set_item_86 call in flight: their button waits, and a second tap does nothing.
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(() => new Set());

  const untilById = React.useMemo(() => new Map(soldOut.map((s) => [s.id, s.sold_out_until])), [soldOut]);
  const soldOutIds = React.useMemo(() => new Set(untilById.keys()), [untilById]);
  const counts = items ? availabilityCounts(items, soldOutIds) : null;
  const groups = items ? availabilityGroups(items, { query, filter, soldOutIds }) : [];

  const run = async (item: AvailabilityItem, action: (it: { id: string; name: string }) => Promise<void>) => {
    if (busy.has(item.id)) return;
    setBusy((curr) => new Set(curr).add(item.id));
    try {
      await action({ id: item.id, name: item.name });
    } finally {
      setBusy((curr) => {
        const next = new Set(curr);
        next.delete(item.id);
        return next;
      });
    }
  };

  return (
    <motion.div
      className="fixed inset-0 z-40 flex justify-end"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
      style={{ background: 'rgba(0,0,0,.35)' }}
    >
      <motion.div
        role="dialog"
        aria-modal="true"
        aria-labelledby="kitchen-availability-title"
        initial={{ x: 420 }}
        animate={{ x: 0 }}
        exit={{ x: 420 }}
        transition={{ ease: 'easeOut', duration: 0.3 }}
        onClick={(e) => e.stopPropagation()}
        // The board's own Escape handler ignores keys typed into a field, so the search box gets
        // its own.
        onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
        className="flex h-full w-full max-w-[420px] flex-col"
        style={{ background: SUN.page, color: SUN.text }}
      >
        <div className="flex items-center gap-2 px-4 py-3 text-white" style={{ background: SUN.header }}>
          <ListChecks className="h-5 w-5" />
          <h2 id="kitchen-availability-title" className="text-[15px] font-semibold">{t('availability.title')}</h2>
          <button type="button" onClick={onClose} aria-label={t('availability.close')} title={t('availability.close')} className="ml-auto">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-2 px-3 pb-2 pt-3" style={{ borderBottom: `1px solid ${SUN.line}` }}>
          <label className="relative block">
            <span className="sr-only">{t('availability.search')}</span>
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" style={{ color: SUN.faint }} aria-hidden />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('availability.search')}
              maxLength={80}
              className="h-10 w-full rounded-xl pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#FF6B2C]/40"
              style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}`, color: SUN.text }}
            />
          </label>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('availability.filterLabel')}>
            {AVAILABILITY_FILTERS.map((f) => {
              const active = filter === f;
              return (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFilter(f)}
                  aria-pressed={active}
                  className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium"
                  style={active
                    ? { background: SUN.accentBg, border: `1px solid ${SUN.accent}`, color: SUN.accentTx }
                    : { background: SUN.card, border: `1px solid ${SUN.cardBorder}`, color: SUN.muted }}
                >
                  {t(`availability.filter.${f}`)}
                  {counts && (
                    <span className="rounded-full px-1.5 text-[11px] tabular-nums" style={{ background: 'rgba(0,0,0,.08)' }}>{counts[f]}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-3 py-2.5">
          {items === null ? (
            loadFailed ? (
              <div className="mt-6 flex flex-col items-center gap-3 px-4 text-center text-sm" style={{ color: '#C0382F' }}>
                <AlertTriangle className="h-6 w-6" />
                <p>{t('availability.loadFailed')}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium"
                  style={{ background: SUN.accentBg, color: SUN.accentTx }}
                >
                  <RotateCcw className="h-4 w-4" />{t('availability.retry')}
                </button>
              </div>
            ) : (
              <div className="mt-8 flex justify-center" style={{ color: SUN.faint }} role="status" aria-label={t('availability.loading')}>
                <Loader2 className="h-6 w-6 animate-spin" />
              </div>
            )
          ) : groups.length === 0 ? (
            <p className="mt-6 px-4 text-center text-sm" style={{ color: SUN.muted }}>
              {items.length === 0 ? t('availability.emptyMenu') : t('availability.noMatch')}
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.category ?? '\u0000none'} className="mb-3">
                <h3 className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide" style={{ color: SUN.faint }}>
                  {g.category ?? t('availability.noCategory')}
                </h3>
                <ul className="overflow-hidden rounded-xl" style={{ background: SUN.card, border: `1px solid ${SUN.cardBorder}` }}>
                  {g.items.map((item, i) => {
                    const until = untilById.get(item.id) ?? null;
                    const badge = stockBadge(item);
                    const pending = busy.has(item.id);
                    return (
                      <li
                        key={item.id}
                        className="flex items-center gap-2 px-3 py-2.5"
                        style={i > 0 ? { borderTop: `1px solid ${SUN.line}` } : undefined}
                      >
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-sm font-medium" style={{ color: until ? SUN.muted : SUN.text }}>{item.name}</div>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px]">
                            {until && (
                              <span className="font-medium" style={{ color: '#C0382F' }} suppressHydrationWarning>
                                {t('availability.soldOutUntil', { time: fmtUntil(until) })}
                              </span>
                            )}
                            {badge?.kind === 'out' && (
                              <span className="rounded-full px-1.5 py-px font-medium" style={{ background: '#FBD9D6', color: '#B43A33' }} title={t('availability.stockHint')}>
                                {t('availability.noneLeft')}
                              </span>
                            )}
                            {badge?.kind === 'low' && (
                              <span className="rounded-full px-1.5 py-px font-medium" style={{ background: '#FCEBC6', color: '#9A6206' }} title={t('availability.stockHint')}>
                                {t('availability.lowStock', { count: badge.count })}
                              </span>
                            )}
                          </div>
                        </div>
                        {until ? (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void run(item, onBackOnSale)}
                            className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                            style={{ background: '#DCF6E8', color: '#13794C' }}
                          >
                            {pending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                            {t('eightySix.backOnSale')}
                          </button>
                        ) : (
                          <button
                            type="button"
                            disabled={pending}
                            onClick={() => void run(item, onSoldOut)}
                            aria-label={t('availability.markSoldOutItem', { item: item.name })}
                            className="flex shrink-0 items-center gap-1 rounded-full px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                            style={{ background: SUN.card, border: '1px solid #F0A8A4', color: '#C0382F' }}
                          >
                            {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ban className="h-3.5 w-3.5" />}
                            {t('availability.markSoldOut')}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </div>

        <p className="px-4 py-2.5 text-[11px] leading-snug" style={{ color: SUN.muted, borderTop: `1px solid ${SUN.line}` }}>
          {t('availability.help')}
        </p>
      </motion.div>
    </motion.div>
  );
}
