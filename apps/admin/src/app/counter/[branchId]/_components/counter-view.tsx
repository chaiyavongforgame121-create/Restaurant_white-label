'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Banknote, CreditCard, Minus, Plus, Search, ShoppingBag, Store,
  Trash2, Utensils, X, Bike,
} from 'lucide-react';
import { formatCurrency, type MenuCategory, type MenuItem } from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import { placeOrder } from '@favornoms/database/queries';
import { Button, Segmented, Sheet } from '@favornoms/ui';
import { PrinterProvider, PrinterStatusButton, usePrinter } from './printer-control';

interface Line {
  id: string;
  menuItemId: string;
  name: string;
  unitPrice: number;
  quantity: number;
  imageUrl: string | null;
}
type Channel = 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
type PayMethod = 'cash' | 'card';

interface Props {
  branchId: string;
  branchName: string;
  categories: MenuCategory[];
  items: MenuItem[];
}

export function CounterView(props: Props) {
  return (
    <PrinterProvider>
      <PosInner {...props} />
    </PrinterProvider>
  );
}

interface ParkedOrder {
  id: string;
  label: string;
  lines: Line[];
  channel: Channel;
  tableNumber: string;
  parkedAt: string;
}

const PARK_STORAGE_KEY = (branchId: string) => `pos-parked-orders:${branchId}`;

function PosInner({ branchId, branchName, categories, items }: Props) {
  const { print, kickDrawer } = usePrinter();
  const [activeCategory, setActiveCategory] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [channel, setChannel] = React.useState<Channel>('dine_in');
  const [payOpen, setPayOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [tableNumber, setTableNumber] = React.useState('');
  const [discountPercent, setDiscountPercent] = React.useState(0);
  const [splitN, setSplitN] = React.useState(1);
  const [parked, setParked] = React.useState<ParkedOrder[]>([]);
  const [showParked, setShowParked] = React.useState(false);

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PARK_STORAGE_KEY(branchId));
      if (raw) setParked(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, [branchId]);

  const persistParked = (next: ParkedOrder[]) => {
    setParked(next);
    try {
      window.localStorage.setItem(PARK_STORAGE_KEY(branchId), JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  };

  const parkCurrent = () => {
    if (lines.length === 0) return;
    const suggested = tableNumber ? `Table ${tableNumber}` : `Order at ${new Date().toLocaleTimeString()}`;
    const label = window.prompt('Label this parked order (e.g. "Table 5", "Sarah pickup"):', suggested);
    if (label === null) return;
    const next: ParkedOrder = {
      id: `parked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: label || suggested,
      lines: lines.slice(),
      channel,
      tableNumber,
      parkedAt: new Date().toISOString(),
    };
    persistParked([next, ...parked]);
    setLines([]);
    setTableNumber('');
    setDiscountPercent(0);
    setSplitN(1);
  };

  const resumeParked = (parkedId: string) => {
    const target = parked.find((p) => p.id === parkedId);
    if (!target) return;
    if (lines.length > 0) {
      if (!window.confirm('Replace current cart with this parked order?')) return;
    }
    setLines(target.lines);
    setChannel(target.channel);
    setTableNumber(target.tableNumber);
    persistParked(parked.filter((p) => p.id !== parkedId));
    setShowParked(false);
  };

  const discardParked = (parkedId: string) => {
    if (!window.confirm('Discard this parked order?')) return;
    persistParked(parked.filter((p) => p.id !== parkedId));
  };

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      if (activeCategory !== 'all' && i.categoryId !== activeCategory) return false;
      if (!q) return true;
      return i.name.toLowerCase().includes(q);
    });
  }, [items, activeCategory, search]);

  const subtotal = lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0);
  const discountAmount = Math.round(subtotal * (discountPercent / 100));
  const total = subtotal - discountAmount; // Counter — no delivery fee, no svc fee for in-store
  const perPerson = splitN > 1 ? Math.ceil(total / splitN) : 0;

  const addItem = (item: MenuItem) => {
    setLines((curr) => {
      const existing = curr.find((l) => l.menuItemId === item.id);
      if (existing) {
        return curr.map((l) => (l.id === existing.id ? { ...l, quantity: l.quantity + 1 } : l));
      }
      return [
        ...curr,
        {
          id: `${item.id}-${Date.now()}`,
          menuItemId: item.id,
          name: item.name,
          unitPrice: item.price,
          imageUrl: item.imageUrl,
          quantity: 1,
        },
      ];
    });
  };

  const updateQty = (lineId: string, delta: number) => {
    setLines((curr) =>
      curr
        .map((l) => (l.id === lineId ? { ...l, quantity: Math.max(0, l.quantity + delta) } : l))
        .filter((l) => l.quantity > 0),
    );
  };

  const clear = () => setLines([]);

  // Hotkeys: digits 1-9 add the Nth visible menu item; Esc closes pay sheet;
  // Ctrl+P opens payment sheet when there's a cart.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setPayOpen(false);
        return;
      }
      if ((e.key === 'p' || e.key === 'P') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (lines.length > 0) setPayOpen(true);
        return;
      }
      const idx = Number(e.key);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 9) {
        const target = filtered[idx - 1];
        if (target) addItem(target);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [filtered, lines.length]);

  const handlePay = async (method: PayMethod) => {
    setSubmitting(true);
    const snapshotLines = lines;
    const snapshotTotal = total;
    try {
      const supabase = getBrowserClient();
      const result = await placeOrder(supabase, {
        branch_id: branchId,
        channel,
        customer_name: tableNumber ? `Table ${tableNumber}` : 'Walk-in',
        customer_phone: '+10000000000',
        customer_notes: tableNumber ? `Table ${tableNumber}` : undefined,
        payment_method: method,
        items: lines.map((l) => ({ menu_item_id: l.menuItemId, quantity: l.quantity })),
      });
      if (discountAmount > 0) {
        await supabase.from('orders').update({ discount_amount: discountAmount, total }).eq('id', result.order_id);
      }
      await supabase.from('orders').update({ status: 'confirmed' }).eq('id', result.order_id);
      setSuccess(result.order_number);
      clear();
      setPayOpen(false);

      // Fire-and-forget receipt print + cash drawer kick on cash payments
      void print({
        branchName,
        orderNumber: result.order_number,
        channel,
        createdAt: new Date().toISOString(),
        items: snapshotLines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          unit_price: l.unitPrice,
        })),
        subtotal: snapshotTotal,
        total: snapshotTotal,
        paymentMethod: method,
      });
      if (method === 'cash') {
        void kickDrawer();
      }

      setTimeout(() => setSuccess(null), 4000);
    } catch (err) {
      alert((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-dynamic-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border/60 bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-warm text-white shadow-warm">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Counter · {branchName}</p>
            <h1 className="font-display text-lg font-bold">Take new order</h1>
          </div>
        </div>
        <div className="hidden items-center gap-3 md:flex">
          <ClockButton branchId={branchId} />
          <button
            type="button"
            onClick={() => setShowParked((s) => !s)}
            className="focus-ring relative inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
          >
            Parked ({parked.length})
          </button>
          <button
            type="button"
            onClick={parkCurrent}
            disabled={lines.length === 0}
            className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold disabled:opacity-40 hover:bg-muted/70"
          >
            Park order
          </button>
          <a
            href={`/counter/${branchId}/recent`}
            className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
          >
            Recent orders →
          </a>
          <PrinterStatusButton />
          <Segmented
            value={channel}
            onChange={(c) => setChannel(c as Channel)}
            options={[
              { value: 'dine_in', label: 'Dine-in', icon: <Store className="h-4 w-4" /> },
              { value: 'pickup', label: 'Pickup', icon: <ShoppingBag className="h-4 w-4" /> },
              { value: 'delivery', label: 'Delivery', icon: <Bike className="h-4 w-4" /> },
            ]}
          />
        </div>
      </header>

      {showParked && (
        <div className="border-b border-border/60 bg-muted/40 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">Parked orders ({parked.length})</h3>
            <button
              type="button"
              onClick={() => setShowParked(false)}
              className="focus-ring rounded-full p-1 text-muted-foreground hover:bg-muted"
              aria-label="Close parked"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {parked.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">No parked orders. Tap "Park order" to save the current cart.</p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {parked.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {p.lines.length} item{p.lines.length === 1 ? '' : 's'} · {new Date(p.parkedAt).toLocaleTimeString()}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => resumeParked(p.id)}
                      className="focus-ring rounded-lg bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground"
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      onClick={() => discardParked(p.id)}
                      className="focus-ring rounded-lg bg-muted px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                    >
                      ×
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left — menu grid */}
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-card/50 px-4 py-3">
            <div className="relative flex-1">
              <Search className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search…"
                className="focus-ring h-11 w-full rounded-full border border-border bg-card pl-10 pr-4 text-base"
              />
            </div>
            <button
              onClick={() => setActiveCategory('all')}
              className={`focus-ring inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
                activeCategory === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'
              }`}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                onClick={() => setActiveCategory(c.id)}
                className={`focus-ring inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
                  activeCategory === c.id
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card'
                }`}
              >
                <span aria-hidden>{c.iconEmoji ?? '🍴'}</span> {c.name}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-4">
            {filtered.length === 0 ? (
              <div className="grid place-items-center py-20 text-center">
                <div>
                  <Utensils className="mx-auto h-10 w-10 text-muted-foreground" />
                  <p className="mt-2 text-muted-foreground">No items match</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {filtered.map((item) => (
                  <motion.button
                    key={item.id}
                    whileTap={{ scale: 0.96 }}
                    onClick={() => addItem(item)}
                    className="focus-ring overflow-hidden rounded-2xl bg-card text-left shadow-soft transition-shadow hover:shadow-warm"
                  >
                    <div className="relative aspect-square overflow-hidden">
                      {item.imageUrl ? (
                        <Image
                          src={item.imageUrl}
                          alt={item.name}
                          fill
                          sizes="(max-width:640px) 50vw, 20vw"
                          className="object-cover"
                        />
                      ) : (
                        <div className="absolute inset-0 bg-gradient-sunset" aria-hidden />
                      )}
                    </div>
                    <div className="p-2.5">
                      <p className="line-clamp-2 text-sm font-semibold leading-tight">{item.name}</p>
                      <p className="mt-0.5 font-display text-base font-bold text-primary">
                        {formatCurrency(item.price)}
                      </p>
                    </div>
                  </motion.button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right — cart pane */}
        <aside className="flex w-[360px] flex-col border-l border-border/60 bg-card">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
            <h2 className="font-display text-lg font-semibold">Order</h2>
            {lines.length > 0 && (
              <button
                onClick={clear}
                className="focus-ring inline-flex items-center gap-1 text-sm font-medium text-danger"
              >
                <Trash2 className="h-4 w-4" /> Clear
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {lines.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <ShoppingBag className="mx-auto h-10 w-10 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">Tap items to add</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-2">
                <AnimatePresence>
                  {lines.map((line) => (
                    <motion.li
                      key={line.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className="flex items-center gap-3 rounded-xl border border-border/60 p-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="line-clamp-1 text-sm font-semibold">{line.name}</p>
                        <p className="text-xs text-muted-foreground">{formatCurrency(line.unitPrice)} ea</p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateQty(line.id, -1)}
                          className="focus-ring grid h-8 w-8 place-items-center rounded-full bg-muted"
                          aria-label="Decrease"
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-6 text-center font-bold tabular-nums">{line.quantity}</span>
                        <button
                          onClick={() => updateQty(line.id, 1)}
                          className="focus-ring grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground"
                          aria-label="Increase"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </motion.li>
                  ))}
                </AnimatePresence>
              </ul>
            )}
          </div>
          <div className="border-t border-border/60 p-4 space-y-3">
            {channel === 'dine_in' && (
              <input
                value={tableNumber}
                onChange={(e) => setTableNumber(e.target.value)}
                placeholder="Table no."
                inputMode="numeric"
                className="focus-ring h-10 w-full rounded-xl border border-border bg-card px-3 text-base"
              />
            )}
            <div className="flex items-center gap-2">
              <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
                Discount %
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={discountPercent}
                  onChange={(e) => setDiscountPercent(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                  className="focus-ring h-9 w-16 rounded-lg border border-border bg-card px-2 text-base"
                />
              </label>
              <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
                Split
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={splitN}
                  onChange={(e) => setSplitN(Math.max(1, Math.min(20, Number(e.target.value) || 1)))}
                  className="focus-ring h-9 w-16 rounded-lg border border-border bg-card px-2 text-base"
                />
              </label>
            </div>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-muted-foreground">
                {discountAmount > 0 ? `${formatCurrency(subtotal)} − ${discountPercent}% =` : 'Total'}
              </span>
              <span className="font-display text-3xl font-bold text-primary">{formatCurrency(total)}</span>
            </div>
            {perPerson > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                {formatCurrency(perPerson)} per person ({splitN} ways)
              </p>
            )}
            <Button
              variant="gradient"
              size="xl"
              fullWidth
              disabled={lines.length === 0}
              onClick={() => setPayOpen(true)}
            >
              Charge {formatCurrency(total)}
            </Button>
          </div>
        </aside>
      </div>

      {/* Payment sheet */}
      <Sheet open={payOpen} onClose={() => setPayOpen(false)} title="Take payment" side="bottom">
        <div className="space-y-3 p-5">
          <p className="text-center font-display text-4xl font-bold text-primary">
            {formatCurrency(total)}
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {([
              { m: 'cash', label: 'Cash', Icon: Banknote },
              { m: 'card', label: 'Card', Icon: CreditCard },
            ] as const).map(({ m, label, Icon }) => (
              <Button
                key={m}
                variant="outline"
                size="xl"
                fullWidth
                loading={submitting}
                onClick={() => handlePay(m)}
                leftIcon={<Icon className="h-5 w-5" />}
              >
                {label}
              </Button>
            ))}
          </div>
        </div>
      </Sheet>

      {/* Success toast */}
      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed inset-x-0 bottom-6 z-50 mx-auto w-fit rounded-2xl bg-success px-5 py-3 text-white shadow-warm"
          >
            <span className="font-semibold">✓ Order {success} sent to kitchen</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ClockButton({ branchId }: { branchId: string }) {
  const [openShiftId, setOpenShiftId] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const supabase = getBrowserClient();
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data: sm } = await supabase
        .from('staff_members')
        .select('id')
        .eq('user_id', user.user.id)
        .eq('branch_id', branchId)
        .maybeSingle();
      if (!sm) return;
      const { data: shift } = await supabase
        .from('staff_shifts')
        .select('id, clocked_out_at')
        .eq('staff_member_id', sm.id)
        .is('clocked_out_at', null)
        .maybeSingle();
      if (!cancelled && shift) setOpenShiftId(shift.id);
    })();
    return () => { cancelled = true; };
  }, [branchId]);

  const handle = async () => {
    setLoading(true);
    setError(null);
    const supabase = getBrowserClient();
    if (openShiftId) {
      const { error: rpcErr } = await supabase.rpc('clock_out', { p_shift_id: openShiftId });
      if (rpcErr) setError(rpcErr.message);
      else setOpenShiftId(null);
    } else {
      const { data, error: rpcErr } = await supabase.rpc('clock_in', { p_branch_id: branchId, p_shift_role: 'cashier' });
      if (rpcErr) setError(rpcErr.message);
      else setOpenShiftId(data as string);
    }
    setLoading(false);
  };

  return (
    <button
      type="button"
      onClick={handle}
      disabled={loading}
      title={error ?? undefined}
      className={`focus-ring inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold ${
        openShiftId
          ? 'bg-success/15 text-success hover:bg-success/25'
          : 'bg-muted hover:bg-muted/70'
      }`}
    >
      {openShiftId ? '🕒 Clock out' : '🕒 Clock in'}
    </button>
  );
}
