'use client';

// The till's window onto the kitchen: what the cooks have, in which lane, and how long each ticket
// has waited, so the cashier can answer "is my order ready?" without walking to the pass. It only
// watches. Nothing in it writes: no Accept, no Ready, no tick, no reject, no 86. Those live on the
// kitchen board (/kitchen/[branchId]), which anyone who opens it from the back office or the
// sidebar keeps using exactly as before; this modal is a separate, read-only reader of the same
// orders and changes nothing about that screen.
//
// While it is open it also holds the keyboard: the till's own shortcuts (1-9 opens a dish, Ctrl+P
// pays) and Tab would otherwise reach the screen behind a modal that says nothing can be done here.

import * as React from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'framer-motion';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, CheckCircle2, ChefHat, Circle, Eye, ShoppingBag, Store, X } from 'lucide-react';
import type { RealtimePostgresChangesPayload } from '@supabase/supabase-js';
import { getBrowserClient } from '@favornoms/database/client';
import { useRealtime } from '@favornoms/database/realtime';
import { intlLocaleFor, isUiLocale, DEFAULT_UI_LOCALE } from '@favornoms/shared';
import { Portal, RiderIcon, cn } from '@favornoms/ui';
import {
  ALLERGY_RE,
  agingTierKey,
  comboParts,
  fmtTimer,
  isLineDone,
  laneOf,
  parseMods,
  safeElapsedSec,
  type Order,
  type TierKey,
} from '@/app/kitchen/[branchId]/_components/kitchen-model';
import {
  ACTIVE_STATUSES,
  KITCHEN_LANES,
  KITCHEN_VIEW_SELECT,
  kitchenLanes,
  laneClockStart,
  lineProgress,
  orderNote,
  tableLabel,
  type KitchenLane,
} from './kitchen-status-model';

/** A missed realtime event is picked up by the next read; this is the floor under it. */
const POLL_MS = 30_000;
/** A burst of changes (an order and its lines, several ticks) becomes one read. */
const COALESCE_MS = 250;

interface Props {
  branchId: string;
  /** Minutes before its slot a scheduled order reaches the kitchen (the board's lead time). */
  leadMin: number;
  /** The branch's time zone, for a scheduled order's slot; the device's when unknown. */
  branchTimezone: string | null;
}

/** The header button and the modal it opens. Rendered only for an account that may see the
 *  kitchen's status (kitchen.status, or kitchen.access): see page.tsx. */
export function KitchenStatusButton(props: Props) {
  const t = useTranslations('counter');
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('kitchenView.button')}
        title={t('kitchenView.button')}
        aria-haspopup="dialog"
        className="focus-ring inline-flex h-9 min-w-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-2 text-xs font-semibold hover:bg-muted sm:px-2.5"
      >
        <ChefHat className="h-[18px] w-[18px]" />
        <span className="hidden sm:inline">{t('kitchenView.button')}</span>
      </button>
      <AnimatePresence>{open && <KitchenStatusModal {...props} onClose={close} />}</AnimatePresence>
    </>
  );
}

function KitchenStatusModal({ branchId, leadMin, branchTimezone, onClose }: Props & { onClose: () => void }) {
  const t = useTranslations('counter');
  const tk = useTranslations('kitchen');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const titleId = React.useId();
  const panelRef = React.useRef<HTMLDivElement>(null);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const onCloseRef = React.useRef(onClose);
  onCloseRef.current = onClose;
  const [orders, setOrders] = React.useState<Order[] | null>(null);
  const [readFailed, setReadFailed] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());
  const [lane, setLane] = React.useState<KitchenLane>('new');
  const leadMs = Math.max(0, leadMin) * 60_000;

  // Every order id the last read returned (held, unpaid and empty ones included), so a line change
  // for an order of another branch (an owner sees every branch's lines) does not re-read this one.
  const knownIds = React.useRef<Set<string>>(new Set());

  // Only the newest read may land: the realtime refetch, the poll and a reconnect can overlap.
  const readSeq = React.useRef(0);
  const reload = React.useCallback(async () => {
    const seq = ++readSeq.current;
    // Unbounded, as the board reads it: a limit on an ordered read drops tickets the board shows.
    const { data, error } = await getBrowserClient()
      .from('orders')
      .select(KITCHEN_VIEW_SELECT)
      .eq('branch_id', branchId)
      .in('status', ACTIVE_STATUSES)
      .order('created_at', { ascending: false });
    if (seq !== readSeq.current) return;
    if (error) {
      console.error('counter kitchen view: orders read failed', error.message);
      setReadFailed(true);
      return;
    }
    const rows = (data ?? []) as unknown as Order[];
    knownIds.current = new Set(rows.map((o) => o.id));
    setReadFailed(false);
    setOrders(rows);
  }, [branchId]);

  const reloadTimer = React.useRef<number | null>(null);
  const requestReload = React.useCallback(() => {
    if (reloadTimer.current != null) return;
    reloadTimer.current = window.setTimeout(() => {
      reloadTimer.current = null;
      void reload();
    }, COALESCE_MS);
  }, [reload]);

  // Re-read on connect, reconnect, tab focus and network return (the hook), and on changes that
  // can move this branch's tickets: any of its orders, and any line except an UPDATE of a line
  // whose order this view has never seen. An INSERT or DELETE always re-reads (a DELETE payload
  // carries only the line's id, and a new order's lines can land before the order's own event).
  const { healthy } = useRealtime({
    channel: `counter-kitchen-view:${branchId}`,
    tables: [
      { table: 'orders', filter: `branch_id=eq.${branchId}` },
      // order_items has no branch_id; RLS limits it to this account's branches.
      { table: 'order_items' },
    ],
    refetch: reload,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    onChange: (payload: RealtimePostgresChangesPayload<any>, table: string) => {
      if (table === 'order_items' && payload.eventType === 'UPDATE') {
        const orderId = (payload.new as { order_id?: string } | null)?.order_id;
        if (orderId && !knownIds.current.has(orderId)) return;
      }
      requestReload();
    },
  });

  // The first read goes out at once (not on the socket's first connect, which can take a while on
  // poor wifi), then a poll keeps the floor; the clock ticks every second for the timers.
  React.useEffect(() => {
    void reload();
    const poll = window.setInterval(() => void reload(), POLL_MS);
    const tick = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      window.clearInterval(poll);
      window.clearInterval(tick);
      if (reloadTimer.current != null) window.clearTimeout(reloadTimer.current);
      readSeq.current += 1; // a read still in flight lands nowhere
    };
  }, [reload]);

  // Keyboard, focus and scroll, set up once. Capture phase on window runs before the till's own
  // window listeners: Escape closes, Tab cycles inside the panel, and every other key stops here so
  // no till shortcut fires behind the modal. Buttons inside still work: a key's default action
  // (Enter/Space clicking a button) is not cancelled by stopping propagation.
  React.useEffect(() => {
    const returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      if (e.key === 'Tab') {
        const panel = panelRef.current;
        if (!panel) return;
        const focusables = Array.from(
          panel.querySelectorAll<HTMLElement>('button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'),
        ).filter((el) => el.offsetParent !== null);
        e.stopPropagation();
        if (focusables.length === 0) {
          e.preventDefault();
          return;
        }
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !panel.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !panel.contains(active))) {
          e.preventDefault();
          first.focus();
        }
        return;
      }
      e.stopPropagation();
    };
    window.addEventListener('keydown', onKey, true);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.body.style.overflow = prevOverflow;
      returnTo?.focus();
    };
  }, []);

  const lanes = React.useMemo(() => kitchenLanes(orders ?? []), [orders]);
  const total = lanes.new.length + lanes.cooking.length + lanes.ready.length;
  const live = healthy && !readFailed;
  const timer = React.useMemo(
    () => ({
      hoursMinutes: (hours: number, minutes: number) => tk('timer.hoursMinutes', { hours, minutes }),
      daysHours: (days: number, hours: number) => tk('timer.daysHours', { days, hours }),
    }),
    [tk],
  );
  // A scheduled slot in the branch's time and the screen's language, as the rest of the till
  // writes times. An unknown zone falls back to the device's rather than throwing.
  const slotFormat = React.useMemo(() => {
    const opts: Intl.DateTimeFormatOptions = { hour: 'numeric', minute: '2-digit' };
    try {
      return new Intl.DateTimeFormat(intlLocaleFor(locale), { ...opts, timeZone: branchTimezone ?? undefined });
    } catch {
      return new Intl.DateTimeFormat(intlLocaleFor(locale), opts);
    }
  }, [locale, branchTimezone]);

  return (
    <Portal>
      {/* Its own layout group: framer-motion shares layout ids across the page, and the till's
          channel picker would otherwise animate out of this modal's elements when it closes. */}
      <LayoutGroup id="counter-kitchen-view">
        <motion.div
          className="fixed inset-0 z-[70] flex items-end justify-center bg-black/55 backdrop-blur-sm sm:items-center sm:p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onClick={onClose}
        >
          <motion.div
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="flex h-[92dvh] w-full max-w-6xl flex-col overflow-hidden rounded-t-3xl bg-background shadow-warm sm:h-[86dvh] sm:rounded-3xl"
            initial={{ y: 40, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 40, opacity: 0, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 380, damping: 34 }}
            onClick={(e) => e.stopPropagation()}
          >
            <header className="flex items-start gap-3 border-b border-border/70 bg-card px-4 py-3 sm:px-6 sm:py-4">
              <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
                <ChefHat className="h-6 w-6" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 id={titleId} className="font-display text-xl font-bold sm:text-2xl">
                    {t('kitchenView.title')}
                  </h2>
                  <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2.5 py-0.5 text-xs font-semibold text-muted-foreground">
                    <Eye className="h-3.5 w-3.5" />
                    {t('kitchenView.viewOnly')}
                  </span>
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
                      live ? 'bg-success/15 text-success' : 'bg-warning/15 text-warning',
                    )}
                  >
                    <span className={cn('h-2 w-2 rounded-full', live ? 'animate-pulse bg-success' : 'bg-warning')} />
                    {live ? t('kitchenView.live') : t('kitchenView.reconnecting')}
                  </span>
                </div>
                <p className="mt-0.5 text-sm text-muted-foreground">{t('kitchenView.subtitle')}</p>
              </div>
              <button
                ref={closeRef}
                type="button"
                onClick={onClose}
                aria-label={t('kitchenView.close')}
                className="focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-muted"
              >
                <X className="h-5 w-5" />
              </button>
            </header>

            {readFailed && (
              <div role="alert" className="flex items-center gap-2 border-b border-danger/30 bg-danger/10 px-4 py-2 text-sm font-medium text-danger sm:px-6">
                <AlertTriangle className="h-4 w-4 shrink-0" />
                {t('kitchenView.readFailed')}
              </div>
            )}

            {/* One lane at a time on a phone; all three side by side from md up. Plain tabs, not
                the shared Segmented, which carries a page-wide layout id. */}
            <div className="border-b border-border/70 px-4 py-2 md:hidden">
              <div role="tablist" aria-label={t('kitchenView.title')} className="flex gap-1 rounded-full bg-muted p-1">
                {KITCHEN_LANES.map((l) => (
                  <button
                    key={l}
                    type="button"
                    role="tab"
                    aria-selected={lane === l}
                    onClick={() => setLane(l)}
                    className={cn(
                      'focus-ring flex-1 rounded-full px-2 py-1.5 text-sm font-semibold transition-colors',
                      lane === l ? 'bg-primary text-primary-foreground shadow-warm' : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {tk(`lanes.${l}`)} · {lanes[l].length}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex min-h-0 flex-1 flex-col overflow-hidden p-3 sm:p-4">
              {orders === null ? (
                <div className="grid flex-1 place-items-center text-sm text-muted-foreground">
                  {readFailed ? t('kitchenView.readFailed') : t('kitchenView.loading')}
                </div>
              ) : (
                <>
                  {total === 0 && (
                    <div className="mb-3 flex items-center justify-center gap-2 rounded-2xl bg-success/10 px-4 py-3 text-sm font-semibold text-success">
                      <CheckCircle2 className="h-5 w-5" />
                      {t('kitchenView.emptyAll')}
                    </div>
                  )}
                  <div className="grid min-h-0 flex-1 grid-cols-1 gap-3 md:grid-cols-3 md:gap-4">
                    {KITCHEN_LANES.map((l) => (
                      <LaneColumn
                        key={l}
                        lane={l}
                        count={lanes[l].length}
                        hiddenOnPhone={l !== lane}
                        title={tk(`lanes.${l}`)}
                        emptyText={t('kitchenView.emptyLane')}
                      >
                        {lanes[l].map((o) => (
                          <TicketCard key={o.id} order={o} now={now} leadMs={leadMs} timer={timer} slotFormat={slotFormat} />
                        ))}
                      </LaneColumn>
                    ))}
                  </div>
                </>
              )}
            </div>
          </motion.div>
        </motion.div>
      </LayoutGroup>
    </Portal>
  );
}

const LANE_DOT: Record<KitchenLane, string> = {
  new: 'bg-amber-500',
  cooking: 'bg-orange-500',
  ready: 'bg-success',
};

function LaneColumn({
  lane,
  count,
  hiddenOnPhone,
  title,
  emptyText,
  children,
}: {
  lane: KitchenLane;
  count: number;
  hiddenOnPhone: boolean;
  title: string;
  emptyText: string;
  children: React.ReactNode;
}) {
  return (
    <section
      aria-label={title}
      className={cn(
        'min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-muted/40',
        hiddenOnPhone ? 'hidden md:flex' : 'flex',
      )}
    >
      <div className="flex items-center gap-2 px-3.5 py-2.5">
        <span className={cn('h-2.5 w-2.5 rounded-full', LANE_DOT[lane])} />
        <h3 className="font-display text-sm font-semibold uppercase tracking-wider">{title}</h3>
        <span className="ml-auto rounded-full bg-card px-2 py-0.5 text-xs font-bold tabular-nums shadow-sm">{count}</span>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {count === 0 && (
          <p className="rounded-xl border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">{emptyText}</p>
        )}
        {/* Always mounted, so a ticket arriving in an empty lane, or leaving the last one, still
            animates. The cards present when the modal opens appear with it, without their own. */}
        <ul className="space-y-2.5">
          <AnimatePresence initial={false}>{children}</AnimatePresence>
        </ul>
      </div>
    </section>
  );
}

const TIER_PILL: Record<TierKey, string> = {
  fresh: 'bg-success/15 text-success',
  work: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  warn: 'bg-orange-500/15 text-orange-700 dark:text-orange-400',
  late: 'bg-danger/15 text-danger',
  crit: 'bg-danger text-white',
};

function ChannelChip({ channel, label }: { channel: string; label: string }) {
  const icon =
    channel === 'delivery' ? (
      <RiderIcon className="h-3.5 w-3.5" />
    ) : channel === 'pickup' ? (
      <ShoppingBag className="h-3.5 w-3.5" />
    ) : (
      <Store className="h-3.5 w-3.5" />
    );
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
      {icon}
      {label}
    </span>
  );
}

const KNOWN_CHANNELS = ['dine_in', 'pickup', 'delivery', 'qr_ordering'];

function TicketCard({
  order,
  now,
  leadMs,
  timer,
  slotFormat,
}: {
  order: Order;
  now: number;
  leadMs: number;
  timer: { hoursMinutes: (h: number, m: number) => string; daysHours: (d: number, h: number) => string };
  slotFormat: Intl.DateTimeFormat;
}) {
  const t = useTranslations('counter');
  const tk = useTranslations('kitchen');
  const lane = laneOf(order.status);
  const sec = safeElapsedSec(laneClockStart(order, leadMs), now);
  const tier = agingTierKey(sec, lane);
  const clock = fmtTimer(sec, timer);
  const { done, total } = lineProgress(order);
  const table = tableLabel(order, (n) => tk('card.table', { table: n }));
  const note = orderNote(order);
  const isAllergy = note ? ALLERGY_RE.test(note) : false;
  const scheduledAt = order.scheduled_for ? new Date(order.scheduled_for) : null;
  const slot = scheduledAt && Number.isFinite(scheduledAt.getTime()) ? slotFormat.format(scheduledAt) : null;

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96 }}
      transition={{ duration: 0.2 }}
      className="rounded-2xl border border-border/70 bg-card p-3 shadow-sm"
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-display text-xl font-bold tabular-nums leading-none">#{order.order_number.slice(-4)}</span>
            <ChannelChip
              channel={order.channel}
              label={KNOWN_CHANNELS.includes(order.channel) ? tk(`channel.${order.channel}` as 'channel.dine_in') : order.channel.replace(/_/g, ' ')}
            />
            {table && (
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-semibold text-primary [overflow-wrap:anywhere]">
                {table}
              </span>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
            {order.customer_name && <span className="truncate font-medium text-foreground/80">{order.customer_name}</span>}
            {lane === 'new' && (
              <span className={order.status === 'pending' ? 'font-semibold text-amber-700 dark:text-amber-400' : ''}>
                {order.status === 'pending' ? t('kitchenView.notAccepted') : t('kitchenView.accepted')}
              </span>
            )}
            {slot && <span>{t('kitchenView.scheduledFor', { time: slot })}</span>}
          </div>
        </div>
        <span className={cn('shrink-0 rounded-full px-2.5 py-1 text-xs font-bold tabular-nums', TIER_PILL[tier], tier === 'crit' && 'animate-pulse')}>
          {lane === 'ready' ? t('kitchenView.readyFor', { time: clock }) : clock}
        </span>
      </div>

      {total > 1 && (
        <div className="mt-2.5">
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-success transition-[width] duration-500" style={{ width: `${(done / total) * 100}%` }} />
          </div>
          <p className="mt-1 text-[11px] font-medium text-muted-foreground">{t('kitchenView.progress', { done, total })}</p>
        </div>
      )}

      <ul className="mt-2 space-y-1.5">
        {order.order_items.map((it) => {
          const lineDone = isLineDone(it);
          const mods = parseMods(it.modifiers);
          const parts = comboParts(it);
          return (
            <li key={it.id} className="flex items-start gap-2">
              {lineDone ? (
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label={t('kitchenView.lineDone')} />
              ) : (
                <Circle className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden />
              )}
              <div className={cn('min-w-0 flex-1', lineDone && 'opacity-60')}>
                <p className={cn('text-sm font-medium leading-snug [overflow-wrap:anywhere]', lineDone && 'line-through')}>
                  <span className="tabular-nums text-primary">{it.quantity}×</span> {it.item_name}
                </p>
                {parts.length > 0 && (
                  <ul className="mt-0.5">
                    {parts.map((p, i) => (
                      <li key={`${p.menu_item_id ?? p.name}-${i}`} className="text-xs leading-snug text-muted-foreground [overflow-wrap:anywhere]">
                        · {p.quantity * it.quantity}× {p.name}
                      </li>
                    ))}
                  </ul>
                )}
                {(mods.length > 0 || it.notes) && (
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {mods.map((m, i) => (
                      <span
                        key={i}
                        className={cn(
                          'max-w-full rounded-md px-1.5 py-px text-[11px] [overflow-wrap:anywhere]',
                          m.remove ? 'bg-danger/10 text-danger' : 'bg-amber-500/15 text-amber-800 dark:text-amber-300',
                        )}
                      >
                        {m.label}
                      </span>
                    ))}
                    {it.notes && (
                      <span className="max-w-full rounded-md bg-muted px-1.5 py-px text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                        {it.notes}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      {note && (
        <div
          className={cn(
            'mt-2.5 flex items-start gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium',
            isAllergy ? 'bg-danger/10 text-danger' : 'bg-amber-500/10 text-amber-800 dark:text-amber-300',
          )}
        >
          {isAllergy && <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />}
          <span className="min-w-0 [overflow-wrap:anywhere]">{isAllergy ? tk('card.allergyNote', { note }) : note}</span>
        </div>
      )}
    </motion.li>
  );
}
