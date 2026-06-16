'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bike, ChefHat, Coffee, Maximize2, ShoppingBag, Store, Undo2, Volume2, VolumeX,
} from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { useRouter, usePathname } from 'next/navigation';
import { Badge, Button, IconButton } from '@favornoms/ui';
import { OpsToggles } from './ops-toggles';

interface OrderItem {
  id: string;
  item_name: string;
  quantity: number;
  notes?: string | null;
  prep_status: string;
  station?: string | null;
}
interface Order {
  id: string;
  order_number: string;
  status: 'pending' | 'confirmed' | 'preparing' | 'ready' | string;
  channel: 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering' | string;
  created_at: string;
  customer_name?: string | null;
  customer_notes?: string | null;
  /** Scheduled order on hold — released by cron at scheduled_for − prep_time. */
  held?: boolean;
  scheduled_for?: string | null;
  order_items: OrderItem[];
  /** Delivery channel: the rider's dispatch status, shown on the ready card. */
  deliveries?: { status: string; driver_id: string | null; accepted_at: string | null }[];
}

interface Props {
  branchId: string;
  branchName: string;
  initialOrders: Order[];
  stations: string[];
  activeStation: string | null;
}

const channelIcon = {
  dine_in: Store,
  pickup: ShoppingBag,
  delivery: Bike,
  qr_ordering: Coffee,
} as const;

export function KitchenView({ branchId, branchName, initialOrders, stations, activeStation }: Props) {
  const [orders, setOrders] = React.useState<Order[]>(initialOrders);
  const [soundOn, setSoundOn] = React.useState(true);
  const [now, setNow] = React.useState(() => Date.now());
  const prevCountRef = React.useRef(initialOrders.length);

  // Filter orders to those that have items on this station (or all if no station)
  const filteredOrders = React.useMemo(() => {
    if (!activeStation) return orders;
    return orders
      .map((o) => ({
        ...o,
        order_items: o.order_items.filter((it) => it.station === activeStation),
      }))
      .filter((o) => o.order_items.length > 0);
  }, [orders, activeStation]);

  // Refresh "elapsed" every 5s
  React.useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(id);
  }, []);

  // Realtime subscribe — orders + order_items
  React.useEffect(() => {
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`kitchen-branch:${branchId}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'orders', filter: `branch_id=eq.${branchId}` },
        async (payload) => {
          const row = payload.new as Order;
          // Fetch its items
          const { data: items } = await supabase
            .from('order_items')
            .select('id, item_name, quantity, notes, prep_status, station')
            .eq('order_id', row.id);
          setOrders((curr) => [...curr, { ...row, order_items: items ?? [] }]);
        },
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `branch_id=eq.${branchId}` },
        (payload) => {
          const updated = payload.new as Order;
          setOrders((curr) => {
            if (!['pending', 'confirmed', 'preparing', 'ready'].includes(updated.status)) {
              return curr.filter((o) => o.id !== updated.id);
            }
            // Preserve the joined deliveries we already have (the orders payload omits it).
            return curr.map((o) => (o.id === updated.id ? { ...o, ...updated, deliveries: o.deliveries } : o));
          });
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'deliveries', filter: `branch_id=eq.${branchId}` },
        (payload) => {
          const d = payload.new as { order_id?: string; status?: string; driver_id?: string | null; accepted_at?: string | null };
          if (!d?.order_id) return;
          setOrders((curr) =>
            curr.map((o) =>
              o.id === d.order_id
                ? { ...o, deliveries: [{ status: d.status ?? 'pending', driver_id: d.driver_id ?? null, accepted_at: d.accepted_at ?? null }] }
                : o,
            ),
          );
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [branchId]);

  // Audio alert when new order arrives
  React.useEffect(() => {
    if (!soundOn) return;
    if (orders.length > prevCountRef.current) {
      // Beep with WebAudio (no asset file needed)
      try {
        const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.0001, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.4);
        osc.start();
        osc.stop(ctx.currentTime + 0.4);
      } catch {
        // ignore — autoplay may be blocked until user interacts
      }
    }
    prevCountRef.current = orders.length;
  }, [orders.length, soundOn]);

  const goFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      // ignore
    }
  };

  // Group by status for visual section dividers. Held (scheduled) orders sit in
  // their own lane until the release cron flips held=false.
  const sections = {
    scheduled: filteredOrders.filter((o) => o.held),
    incoming: filteredOrders.filter((o) => o.status === 'pending' && !o.held),
    new: filteredOrders.filter((o) => o.status === 'confirmed' && !o.held),
    making: filteredOrders.filter((o) => o.status === 'preparing'),
    ready: filteredOrders.filter((o) => o.status === 'ready'),
  };

  return (
    <div className="flex min-h-dynamic-screen flex-col">
      <header className="flex items-center justify-between border-b border-border/60 px-6 py-4">
        <div className="flex items-center gap-4">
          <div className="grid h-12 w-12 place-items-center rounded-xl bg-gradient-warm text-white shadow-warm">
            <ChefHat className="h-6 w-6" />
          </div>
          <div>
            <h1 className="font-display text-2xl font-bold">
              {branchName} · Kitchen
              {activeStation && (
                <span className="ml-2 rounded-full bg-primary px-2 py-0.5 align-middle text-xs font-semibold text-primary-foreground">
                  {activeStation}
                </span>
              )}
            </h1>
            <p className="text-sm text-muted-foreground">
              {filteredOrders.length} active · live updates
              {activeStation ? ` · station "${activeStation}"` : ''}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <OpsToggles branchId={branchId} />
          {stations.length > 0 && (
            <StationFilter stations={stations} active={activeStation} />
          )}
          <IconButton label="Toggle sound" onClick={() => setSoundOn((s) => !s)}>
            {soundOn ? <Volume2 className="h-5 w-5" /> : <VolumeX className="h-5 w-5" />}
          </IconButton>
          <IconButton label="Fullscreen" onClick={goFullscreen}>
            <Maximize2 className="h-5 w-5" />
          </IconButton>
        </div>
      </header>

      <main className="flex-1 space-y-6 overflow-y-auto p-6">
        {sections.scheduled.length > 0 && (
          <section>
            <div className="mb-3">
              <h2 className="inline-flex items-center gap-2 rounded-full bg-muted px-3 py-1 text-sm font-bold text-muted-foreground">
                ⏰ Scheduled · auto-releases before due time
                <span className="rounded-full bg-card px-2 text-xs">{sections.scheduled.length}</span>
              </h2>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {sections.scheduled.map((o) => (
                <div key={o.id} className="rounded-2xl border border-dashed border-border bg-muted/30 p-4">
                  <div className="flex items-center justify-between">
                    <p className="font-display text-base font-bold">{o.order_number}</p>
                    <span className="text-xs font-semibold text-muted-foreground">
                      {o.scheduled_for
                        ? new Date(o.scheduled_for).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : ''}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {o.order_items.map((it) => `${it.quantity}× ${it.item_name}`).join(' · ')}
                  </p>
                </div>
              ))}
            </div>
          </section>
        )}
        <Section title="Incoming — tap to accept" tone="warning" orders={sections.incoming} now={now} onUpdate={updateStatus(branchId, setOrders)} branchId={branchId} />
        <Section title="Accepted" tone="primary" orders={sections.new} now={now} onUpdate={updateStatus(branchId, setOrders)} branchId={branchId} />
        <Section title="In the kitchen" tone="accent" orders={sections.making} now={now} onUpdate={updateStatus(branchId, setOrders)} branchId={branchId} />
        <Section title="Ready for pickup" tone="success" orders={sections.ready} now={now} onUpdate={updateStatus(branchId, setOrders)} branchId={branchId} />

        {filteredOrders.length === 0 && (
          <div className="grid place-items-center py-24 text-center">
            <div>
              <ChefHat className="mx-auto h-12 w-12 text-muted-foreground" />
              <p className="mt-3 font-display text-2xl font-semibold">All clear, chef.</p>
              <p className="text-muted-foreground">
                {activeStation
                  ? `No orders for the "${activeStation}" station.`
                  : 'New orders will appear here in real time.'}
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function StationFilter({ stations, active }: { stations: string[]; active: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div className="hidden flex-wrap items-center gap-1 rounded-full border border-border/60 bg-card p-1 lg:flex">
      <button
        onClick={() => router.replace(pathname)}
        className={`focus-ring rounded-full px-3 py-1 text-xs font-semibold transition-colors ${
          !active ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
        }`}
      >
        All
      </button>
      {stations.map((s) => (
        <button
          key={s}
          onClick={() => router.replace(`${pathname}?station=${encodeURIComponent(s)}`)}
          className={`focus-ring rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
            active === s ? 'bg-primary text-primary-foreground' : 'text-foreground hover:bg-muted'
          }`}
        >
          {s}
        </button>
      ))}
    </div>
  );
}

function updateStatus(branchId: string, setOrders: React.Dispatch<React.SetStateAction<Order[]>>) {
  return async (orderId: string, nextStatus: string) => {
    const supabase = getBrowserClient();
    let prevStatus: string | null = null;
    setOrders((curr) =>
      curr.map((o) => {
        if (o.id === orderId) {
          prevStatus = o.status;
          return { ...o, status: nextStatus };
        }
        return o;
      }),
    );
    const { error } = await supabase
      .from('orders')
      .update({ status: nextStatus })
      .eq('id', orderId)
      .eq('branch_id', branchId);
    // Roll the optimistic lane change back on failure so the board never lies.
    if (error && prevStatus !== null) {
      setOrders((curr) => curr.map((o) => (o.id === orderId ? { ...o, status: prevStatus as string } : o)));
    }
  };
}

function Section({
  title, tone, orders, now, onUpdate, branchId,
}: {
  title: string;
  tone: 'primary' | 'accent' | 'success' | 'warning';
  orders: Order[];
  now: number;
  onUpdate: (orderId: string, nextStatus: string) => void;
  branchId: string;
}) {
  if (orders.length === 0) return null;
  const toneCls = tone === 'primary' ? 'bg-primary/15 text-primary' : tone === 'accent' ? 'bg-accent/20 text-accent-foreground' : tone === 'warning' ? 'bg-warning/15 text-warning' : 'bg-success/15 text-success';
  return (
    <section>
      <div className="mb-3 flex items-center gap-2">
        <h2 className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-sm font-bold ${toneCls}`}>
          {title}
          <span className="rounded-full bg-white/30 px-2 text-xs">{orders.length}</span>
        </h2>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
        <AnimatePresence>
          {orders.map((order) => (
            <OrderCard key={order.id} order={order} now={now} onUpdate={onUpdate} branchId={branchId} />
          ))}
        </AnimatePresence>
      </div>
    </section>
  );
}

function OrderCard({
  order, now, onUpdate, branchId,
}: {
  order: Order;
  now: number;
  onUpdate: (orderId: string, nextStatus: string) => void;
  branchId: string;
}) {
  const elapsedMin = Math.floor((now - new Date(order.created_at).getTime()) / 60000);
  // Color-code by elapsed time
  const elapsedColor =
    elapsedMin >= 15 ? 'border-danger/60 bg-danger/5' :
    elapsedMin >= 8 ? 'border-warning/60 bg-warning/5' :
    'border-border/60 bg-card';

  const ChannelIcon = (channelIcon as Record<string, typeof Bike>)[order.channel] ?? ShoppingBag;
  const next: Record<string, string> = {
    pending: 'confirmed',
    confirmed: 'preparing',
    preparing: 'ready',
    ready: 'completed',
  };
  const nextLabel: Record<string, string> = {
    pending: 'Accept order',
    confirmed: 'Start cooking',
    preparing: 'Mark ready',
    ready: 'Bump',
  };
  const isDelivery = order.channel === 'delivery';
  const delivery = order.deliveries?.[0];
  const driverLabel =
    !delivery || delivery.status === 'pending' || delivery.status === 'dispatching'
      ? 'Finding a driver…'
      : delivery.status === 'assigned'
        ? delivery.accepted_at
          ? 'Driver assigned ✓'
          : 'Driver offered…'
        : 'Driver on the way';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.95, y: 12 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.9 }}
      transition={{ duration: 0.25 }}
      className={`flex flex-col rounded-2xl border-2 ${elapsedColor} overflow-hidden shadow-soft`}
    >
      <div className="flex items-center justify-between border-b border-border/60 bg-gradient-to-r from-muted/40 to-transparent px-4 py-3">
        <div className="flex items-center gap-2">
          <ChannelIcon className="h-5 w-5 text-muted-foreground" />
          <span className="font-display text-xl font-bold">{order.order_number.slice(-4)}</span>
        </div>
        <Badge variant={elapsedMin >= 15 ? 'danger' : elapsedMin >= 8 ? 'warning' : 'muted'}>
          {elapsedMin}m
        </Badge>
      </div>
      <div className="flex-1 space-y-1.5 px-4 py-3 text-base">
        {order.order_items.map((item) => (
          <Item86LongPress key={item.id} branchId={branchId} itemName={item.item_name}>
            <div className="flex items-baseline gap-2">
              <span className="font-display text-2xl font-bold text-primary">{item.quantity}×</span>
              <div className="flex-1">
                <p className="font-semibold">{item.item_name}</p>
                {item.notes && <p className="text-xs italic text-muted-foreground">{item.notes}</p>}
              </div>
            </div>
          </Item86LongPress>
        ))}
        {order.customer_notes && (
          <p className="mt-2 rounded-lg bg-warning/10 px-2 py-1 text-xs text-warning">
            📝 {order.customer_notes}
          </p>
        )}
      </div>
      {isDelivery && order.status === 'ready' && <DispatchButton orderId={order.id} />}
      {order.status === 'pending' && (
        <Button
          variant="ghost"
          size="md"
          className="rounded-none border-t border-border/60 text-danger"
          onClick={async () => {
            // Use cancel_order RPC (restores stock for track_stock items + logs the
            // reason) instead of a raw status write. Only flip the UI on success.
            const supabase = getBrowserClient();
            const { error } = await supabase.rpc('cancel_order', {
              p_order_id: order.id,
              p_reason: 'Rejected by kitchen',
            });
            if (!error) onUpdate(order.id, 'cancelled');
          }}
        >
          Reject
        </Button>
      )}
      {order.status === 'ready' && (
        <Button
          variant="ghost"
          size="md"
          className="rounded-none border-t border-border/60"
          onClick={async () => {
            const supabase = getBrowserClient();
            await supabase.rpc('recall_order', { p_order_id: order.id });
            onUpdate(order.id, 'preparing');
          }}
          leftIcon={<Undo2 className="h-4 w-4" />}
        >
          Recall to kitchen
        </Button>
      )}
      {isDelivery && order.status === 'ready' ? (
        // Delivery completion is driven by the driver (picked_up → out_for_delivery → delivered),
        // not a kitchen bump — so 'ready' is the last kitchen step. Show the rider's status here.
        <div className="flex items-center justify-center gap-2 border-t border-border/60 bg-success/5 px-4 py-3 text-sm font-semibold text-success">
          <Bike className="h-4 w-4" /> {driverLabel}
        </div>
      ) : (
        <Button
          variant={order.status === 'ready' ? 'gradient' : 'primary'}
          size="lg"
          fullWidth
          className="rounded-none"
          onClick={() => onUpdate(order.id, next[order.status]!)}
        >
          {nextLabel[order.status]} →
        </Button>
      )}
    </motion.div>
  );
}

// Dispatch a delivery order to an online rider via the `dispatch-driver` edge
// function. Inline, non-blocking status — no alert(), since this runs on an
// always-on kitchen display.
function DispatchButton({ orderId }: { orderId: string }) {
  const [state, setState] = React.useState<'idle' | 'sending' | 'sent' | 'error'>('idle');
  const label =
    state === 'sending' ? 'Finding a driver…'
      : state === 'sent' ? 'Driver requested ✓'
      : state === 'error' ? 'Retry — dispatch failed'
      : 'Find driver';
  const dispatch = async () => {
    setState('sending');
    const supabase = getBrowserClient();
    const { error } = await supabase.functions.invoke('dispatch-driver', {
      body: { order_id: orderId },
    });
    setState(error ? 'error' : 'sent');
    window.setTimeout(() => setState('idle'), 4000);
  };
  return (
    <Button
      variant="ghost"
      size="md"
      disabled={state === 'sending'}
      className={`rounded-none border-t border-border/60 ${state === 'error' ? 'text-danger' : 'text-primary'}`}
      leftIcon={<Bike className="h-4 w-4" />}
      onClick={dispatch}
    >
      {label}
    </Button>
  );
}

// Long-press (700ms) on an item line opens the 86 confirmation, then calls
// `toggle_item_availability` to mark the item out of stock for the branch.
function Item86LongPress({
  branchId,
  itemName,
  children,
}: {
  branchId: string;
  itemName: string;
  children: React.ReactNode;
}) {
  const timer = React.useRef<number | null>(null);
  const triggered = React.useRef(false);
  const [confirming, setConfirming] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [msg, setMsg] = React.useState<string | null>(null);

  const begin = () => {
    triggered.current = false;
    timer.current = window.setTimeout(() => {
      triggered.current = true;
      setMsg(null);
      setConfirming(true);
    }, 700);
  };
  const cancel = () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
  };

  const confirm86 = async () => {
    setBusy(true);
    setMsg(null);
    const supabase = getBrowserClient();
    const { data: row } = await supabase
      .from('menu_items')
      .select('id')
      .eq('branch_id', branchId)
      .ilike('name', itemName)
      .maybeSingle();
    if (!row) {
      setBusy(false);
      setMsg("Couldn't find that item in the menu — it may already be 86'd.");
      return;
    }
    const { error } = await supabase.rpc('toggle_item_availability', {
      p_item_id: row.id,
      p_active: false,
    });
    setBusy(false);
    if (error) {
      setMsg(`Failed: ${error.message}`);
      return;
    }
    setConfirming(false);
  };

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        onMouseDown={begin}
        onMouseUp={cancel}
        onMouseLeave={cancel}
        onTouchStart={begin}
        onTouchEnd={cancel}
        onTouchCancel={cancel}
        className="select-none rounded-md transition-colors active:bg-muted/40"
        title="Long-press to 86 this item"
      >
        {children}
      </div>
      {confirming && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => !busy && setConfirming(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl bg-card p-5 shadow-warm"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="font-display text-lg font-semibold">{`86 "${itemName}"?`}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Mark it unavailable across the menu until you turn it back on.
            </p>
            {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => setConfirming(false)}
                className="focus-ring flex-1 rounded-xl border border-border px-4 py-2.5 text-sm font-semibold"
              >
                Keep available
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={confirm86}
                className="focus-ring flex-1 rounded-xl bg-danger px-4 py-2.5 text-sm font-semibold text-white disabled:opacity-60"
              >
                {busy ? 'Working…' : '86 it'}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
