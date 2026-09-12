'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Banknote, CreditCard, Minus, Plus, Search, ShoppingBag, Store,
  Trash2, Utensils, X, Bike,
} from 'lucide-react';
import {
  billingErrorMessage,
  computeSalesTax,
  computeServiceFee,
  describeBillingError,
  formatCurrency,
  type MenuCategory,
  type MenuItem,
} from '@favornoms/shared';
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

/** One of the branch's tables, as the till needs it. */
export interface CounterTable {
  id: string;
  number: string;
  label: string;
  /** Someone is already sitting there — this order joins their bill. */
  seated: boolean;
}

interface Props {
  branchId: string;
  branchName: string;
  categories: MenuCategory[];
  items: MenuItem[];
  /** Active tables at this branch. Empty for a branch that has never set any up. */
  tables?: CounterTable[];
  /** `card_payment` entitlement — default false so a missing prop cannot sell it. */
  canUseCard?: boolean;
  /** `delivery` entitlement — same. */
  canDeliver?: boolean;
  /** branches.sales_tax_rate as a decimal (0.0701 = 7.01%), the figure place-order taxes
   *  with. Defaults to 0 like the server does, so a missing prop can only undercharge. */
  salesTaxRate?: number;
  /** branches.settings.service_fee_percent — a card-only surcharge on the food subtotal. */
  serviceFeePercent?: number;
  /** branches.settings.delivery_fee. A delivery rung up here carries no address, so
   *  place-order skips quote_delivery and charges this flat figure. */
  deliveryFeeFlat?: number;
}

// place-order's r2, character for character. The cashier collects the number on this
// screen and the server charges its own, so the two have to land on the same cent.
const r2 = (n: number) => Math.round(n * 100) / 100;

// place-order's wire codes, in words a cashier can act on with a customer waiting. The
// storefront keeps its own table for the same codes phrased for a diner; this one names
// the till's remedies — the Pause switch on the kitchen board, an 86'd item — instead.
// Order is significant: `branch_closed_at_scheduled_time` contains `branch_closed`.
const COUNTER_ERRORS: Array<[string, string]> = [
  ['branch_closed_at_scheduled_time', 'The branch is closed at that time.'],
  [
    'branch_closed',
    'Orders are paused, or the branch is outside its opening hours. Un-pause on the kitchen board, or check the hours in Branch settings.',
  ],
  ['rate_limited', 'Too many orders in a row from this till. Wait a moment, then charge again.'],
  [
    'item_sold_out',
    'Something in this order is marked sold out. Take it off, or put it back in stock on the kitchen board.',
  ],
  ['insufficient_stock', 'There is not enough stock left for one of these items.'],
  ['item_inactive', 'Something in this order is no longer on the menu. Take it off and charge again.'],
  [
    'item_not_in_branch',
    'Something in this order belongs to another branch. Clear the cart and ring it up again.',
  ],
  [
    'stale_client_refresh_required',
    'The menu changed while this order was open. Refresh the page and ring it up again.',
  ],
  ['payment_method_not_accepted', 'This branch does not take that payment method for this order type.'],
  ['invalid_payment_method', 'That is not a payment method this branch accepts.'],
  ['table_required', 'Enter a table number for a dine-in order.'],
  ['delivery_out_of_range', 'That address is outside the delivery area.'],
  ['empty_order', 'There is nothing in the cart.'],
  ['invalid_channel', 'Pick dine-in, pickup or delivery, then charge again.'],
];

function describeCounterError(raw: string): string {
  for (const [code, text] of COUNTER_ERRORS) {
    if (raw.includes(code)) return text;
  }
  // placeOrder throws `place_order_failed:<status>:<body>`. A raw wire string in front of a
  // queue is not a message, so anything unrecognised at least says what to do next.
  if (raw.includes('place_order_failed')) {
    return 'That order was refused. Try again, or take it in the back office.';
  }
  return raw;
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

function PosInner({
  branchId,
  branchName,
  categories,
  items,
  tables = [],
  canUseCard = false,
  canDeliver = false,
  salesTaxRate = 0,
  serviceFeePercent = 0,
  deliveryFeeFlat = 0,
}: Props) {
  const { print, kickDrawer } = usePrinter();
  const [activeCategory, setActiveCategory] = React.useState<string>('all');
  const [search, setSearch] = React.useState('');
  const [lines, setLines] = React.useState<Line[]>([]);
  const [channel, setChannel] = React.useState<Channel>('dine_in');
  const [payOpen, setPayOpen] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState<string | null>(null);
  const [tableNumber, setTableNumber] = React.useState('');
  // The row, not the text. place-order refuses a table that is not at this branch, and uses
  // the id to attach this order to whatever sitting is already open there.
  const [tableId, setTableId] = React.useState<string | null>(null);
  const pickedTable = React.useMemo(
    () => tables.find((t) => t.id === tableId) ?? null,
    [tables, tableId],
  );
  const [discountPercent, setDiscountPercent] = React.useState(0);
  const [splitN, setSplitN] = React.useState(1);
  const [parked, setParked] = React.useState<ParkedOrder[]>([]);
  const [showParked, setShowParked] = React.useState(false);
  const [payError, setPayError] = React.useState<string | null>(null);

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
    setTableId(null);
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
    // Parked orders live in localStorage indefinitely, so one can outlive the
    // delivery add-on. Fall back to pickup rather than resuming into a channel
    // place-order will now refuse.
    setChannel(target.channel === 'delivery' && !canDeliver ? 'pickup' : target.channel);
    setTableNumber(target.tableNumber);
    // Re-resolved from the current floor rather than carried in the parked order: a cart
    // parked before lunch can be resumed after the table it named was renumbered or retired.
    setTableId(tables.find((t) => t.number === target.tableNumber)?.id ?? null);
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

  const subtotal = r2(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0));
  // A percentage of a DOLLAR amount, rounded to the cent. Rounding to whole dollars took
  // $2.00 off a $23.40 cart at 10%, and nothing at all off anything under $6.67.
  const discountAmount = Math.min(subtotal, r2(subtotal * (discountPercent / 100)));
  // place-order charges a flat settings.delivery_fee when a delivery order carries no
  // address — which is every delivery rung up at the till.
  const deliveryFee = channel === 'delivery' ? r2(deliveryFeeFlat) : 0;
  const taxAmount = computeSalesTax(subtotal, salesTaxRate);

  // What place-order will price this cart at, per payment method. The screen used to show
  // subtotal minus discount while the server charged tax and the card fee on top, so the
  // cashier collected one number and the order row recorded a higher one — every till
  // session ended short. The service fee is card-only, so Cash and Card are genuinely
  // different amounts and both are named rather than one standing in for the other.
  const quoteFor = React.useCallback(
    (method: PayMethod) => {
      const serviceFee = computeServiceFee(subtotal, serviceFeePercent, method);
      const serverTotal = r2(subtotal + deliveryFee + serviceFee + taxAmount);
      // The till's discount comes off the server's total rather than replacing it —
      // replacing it silently wiped the fee and the tax the server had just charged.
      return { serviceFee, serverTotal, total: r2(Math.max(0, serverTotal - discountAmount)) };
    },
    [subtotal, deliveryFee, taxAmount, serviceFeePercent, discountAmount],
  );
  const cashQuote = quoteFor('cash');
  const cardQuote = quoteFor('card');
  const total = cashQuote.total;
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
    setPayError(null);
    const snapshotLines = lines;
    const expected = quoteFor(method);
    try {
      const supabase = getBrowserClient();
      const result = await placeOrder(supabase, {
        branch_id: branchId,
        channel,
        customer_name: tableNumber ? `Table ${tableNumber}` : 'Walk-in',
        customer_phone: '+10000000000',
        customer_notes: tableNumber ? `Table ${tableNumber}` : undefined,
        // Staff surface: place-order exempts it from the storefront's
        // dine-in-needs-a-table rule, since the counter rings up walk-ins.
        source: 'counter',
        table_id: tableId ?? undefined,
        table_number: tableNumber || undefined,
        payment_method: method,
        items: lines.map((l) => ({ menu_item_id: l.menuItemId, quantity: l.quantity })),
      });
      // Everything past this point settles an order that already exists, so a failure here
      // is never "the sale did not happen". Two kinds of failure, kept apart because they
      // call for opposite things: `paperWrong` means the receipt would not match the row,
      // and no paper beats wrong paper; `booksWrong` means the customer's copy is right but
      // the ledger is not, and that has to be said out loud without stranding a customer at
      // the counter with no receipt. Both used to be discarded and printed over.
      const paperWrong: string[] = [];
      let booksWrong: string | null = null;

      // place-order is the only thing that prices an order, so the row is still the truth
      // the paper has to match. It is read FIRST and used as the assertion on the quote the
      // cashier just showed the customer — not, as before, as the first time the real total
      // was known. Reading it after the discount write would only assert the till's own
      // arithmetic against itself.
      const { data: priced } = await supabase
        .from('orders')
        .select('subtotal, delivery_fee, service_fee, tax_amount, total')
        .eq('id', result.order_id)
        .maybeSingle();
      const serverTotal = priced ? Number(priced.total) : Number(result.total);
      const chargedTotal = r2(Math.max(0, serverTotal - discountAmount));
      if (Math.abs(chargedTotal - expected.total) > 0.005) {
        paperWrong.push(
          `the till quoted ${formatCurrency(expected.total)} and the order priced ${formatCurrency(chargedTotal)}`,
        );
      }

      // The discount lands before the payment is settled, because record_counter_payment
      // re-reads orders.total for the amount it records as received.
      if (discountAmount > 0) {
        const { error: discountErr } = await supabase
          .from('orders')
          .update({ discount_amount: discountAmount, total: chargedTotal })
          .eq('id', result.order_id);
        if (discountErr) paperWrong.push('the discount was not applied to the order');
      }

      // Cash in the drawer is money received, and nothing used to say so: place-order
      // inserts the payment as 'pending' and the till only moved orders.status, so every
      // cash and card sale stayed unsettled forever. The RPC re-reads the order's own
      // total, refuses a QR transfer, and stamps who took the money — a browser is not
      // allowed to simply declare a payment complete.
      const { error: settleErr } = await supabase.rpc('record_counter_payment', {
        p_order_id: result.order_id,
      } as never);
      if (settleErr) {
        booksWrong =
          'the payment was not recorded as taken — settle it from the back office before the cash-up';
        // The RPC also promotes a card sale out of 'pending'. If it could not run, the
        // ticket still has to reach the kitchen, so fall back to the plain status write.
        await supabase
          .from('orders')
          .update({ status: 'confirmed' })
          .eq('id', result.order_id)
          .eq('status', 'pending');
      }

      if (paperWrong.length > 0) {
        // No receipt and no success toast. The cart is cleared anyway because the order is
        // real — ringing it again would charge the customer twice.
        setPayError(
          `Order ${result.order_number} was placed, but ${paperWrong.join(', and ')}. Sort it out in Recent orders before handing over a receipt.`,
        );
        clear();
        return;
      }

      if (booksWrong) setPayError(`Order ${result.order_number} was placed, but ${booksWrong}.`);
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
        subtotal: priced ? Number(priced.subtotal) : subtotal,
        deliveryFee: (priced ? Number(priced.delivery_fee) : deliveryFee) || undefined,
        serviceFee: (priced ? Number(priced.service_fee) : expected.serviceFee) || undefined,
        discount: discountAmount || undefined,
        taxAmount: (priced ? Number(priced.tax_amount) : taxAmount) || undefined,
        total: chargedTotal,
        paymentMethod: method,
      });
      if (method === 'cash') {
        void kickDrawer();
      }

      setTimeout(() => setSuccess(null), 4000);
    } catch (err) {
      // A cashier mid-sale needs the reason, not a raw wire string in a browser alert().
      // Suspension makes place-order refuse every new order here, and the fix for that one
      // is on the Plan page, not at the till.
      const billing = describeBillingError(err);
      setPayError(
        billing ? billingErrorMessage(billing) : describeCounterError((err as Error).message),
      );
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
            href={`/counter/${branchId}/tables`}
            className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
          >
            Tables →
          </a>
          <a
            href={`/counter/${branchId}/recent`}
            className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
          >
            Recent orders →
          </a>
          <PrinterStatusButton />
          <Segmented
            value={channel}
            onChange={(c) => {
              setChannel(c as Channel);
              // The table picker is hidden off dine-in but its state survives.
              // Leaving it set would stamp a pickup order with a real table.
              if (c !== 'dine_in') {
                setTableNumber('');
                setTableId(null);
              }
            }}
            options={[
              { value: 'dine_in', label: 'Dine-in', icon: <Store className="h-4 w-4" /> },
              { value: 'pickup', label: 'Pickup', icon: <ShoppingBag className="h-4 w-4" /> },
              ...(canDeliver
                ? [{ value: 'delivery', label: 'Delivery', icon: <Bike className="h-4 w-4" /> }]
                : []),
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
              <div className="space-y-1.5">
                {/* The picker used to carry an aria-label and nothing visible, so a closed
                    select reading "No table (walk-in)" was indistinguishable from a branch
                    with no tables set up. It was reported as exactly that, with three
                    tables one click away. */}
                <label
                  htmlFor="counter-table"
                  className="text-muted-foreground flex items-center justify-between text-xs font-semibold uppercase tracking-wider"
                >
                  <span>Table</span>
                  {tables.length > 0 && (
                    <span className="font-normal normal-case tracking-normal">
                      {tables.length} on the floor
                    </span>
                  )}
                </label>
                {tables.length > 0 ? (
                  <>
                    <select
                      id="counter-table"
                      value={tableId ?? ''}
                      onChange={(e) => {
                        const picked = tables.find((t) => t.id === e.target.value) ?? null;
                        setTableId(picked?.id ?? null);
                        setTableNumber(picked?.number ?? '');
                      }}
                      className="focus-ring h-10 w-full rounded-xl border border-border bg-card px-3 text-base"
                    >
                      <option value="">No table (walk-in)</option>
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                          {t.seated ? ' · seated' : ''}
                        </option>
                      ))}
                    </select>
                    {/* place-order joins the table's open sitting rather than starting a
                        rival one, so this round lands on the bill the diners' phones are
                        already adding to. Worth saying out loud before Charge is pressed. */}
                    {pickedTable?.seated && (
                      <p className="text-warning text-xs">
                        {pickedTable.label} has an open bill — this round is added to it.
                      </p>
                    )}
                    {pickedTable && !pickedTable.seated && (
                      <p className="text-muted-foreground text-xs">
                        Seats {pickedTable.label} and starts its bill.
                      </p>
                    )}
                  </>
                ) : (
                  // A branch that has never set a table up still has to be able to ring one
                  // up. The typed number is resolved against the branch's rows server-side.
                  <input
                    id="counter-table"
                    value={tableNumber}
                    onChange={(e) => setTableNumber(e.target.value)}
                    placeholder="Table no."
                    inputMode="numeric"
                    className="focus-ring h-10 w-full rounded-xl border border-border bg-card px-3 text-base"
                  />
                )}
              </div>
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
            {/* Every line the server will charge, itemised. The screen showed one bare
                number that left out tax and the card fee, so the cashier could not see
                what the customer was actually being asked for. */}
            <dl className="space-y-1 text-sm">
              <TotalRow label="Subtotal" value={formatCurrency(subtotal)} />
              {discountAmount > 0 && (
                <TotalRow
                  label={`Discount ${discountPercent}%`}
                  value={`−${formatCurrency(discountAmount)}`}
                />
              )}
              {deliveryFee > 0 && <TotalRow label="Delivery" value={formatCurrency(deliveryFee)} />}
              {taxAmount > 0 && <TotalRow label="Sales tax" value={formatCurrency(taxAmount)} />}
            </dl>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-muted-foreground">Total</span>
              <span className="font-display text-3xl font-bold text-primary">
                {formatCurrency(total)}
              </span>
            </div>
            {canUseCard && cardQuote.serviceFee > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                Card adds a {serviceFeePercent}% service fee — {formatCurrency(cardQuote.total)}
              </p>
            )}
            {perPerson > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                {formatCurrency(perPerson)} per person ({splitN} ways)
              </p>
            )}
            {payError && (
              <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
                {payError}
              </p>
            )}
            <Button
              variant="gradient"
              size="xl"
              fullWidth
              disabled={lines.length === 0}
              onClick={() => {
                setPayError(null);
                setPayOpen(true);
              }}
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
          {payError && (
            <p role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
              {payError}
            </p>
          )}
          {/* Card is dropped, not disabled: place-order rejects it server-side
              without the card_payment entitlement, so a visible button would
              only produce a failed sale in front of a waiting customer.
              Each button carries its own total — the card fee makes them differ, and the
              cashier has to know which number to ask for before pressing anything. */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              { m: 'cash' as const, label: 'Cash', Icon: Banknote, amount: cashQuote.total },
              ...(canUseCard
                ? [{ m: 'card' as const, label: 'Card', Icon: CreditCard, amount: cardQuote.total }]
                : []),
            ].map(({ m, label, Icon, amount }) => (
              <Button
                key={m}
                variant="outline"
                size="xl"
                fullWidth
                loading={submitting}
                onClick={() => handlePay(m)}
                leftIcon={<Icon className="h-5 w-5" />}
              >
                {label} · {formatCurrency(amount)}
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

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="tabular-nums">{value}</dd>
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
