'use client';

import * as React from 'react';
import Image from 'next/image';
import { motion, AnimatePresence } from 'framer-motion';
import { useLocale, useTranslations } from 'next-intl';
import {
  Banknote, CreditCard, Minus, Plus, QrCode, Search, ShoppingBag, Store,
  Trash2, Utensils, X,
} from 'lucide-react';
import {
  DEFAULT_UI_LOCALE,
  billingErrorMessage,
  describeBillingError,
  formatCurrency,
  formatUnitPrice,
  intlLocaleFor,
  isUiLocale,
  MAX_LINE_QUANTITY,
  menuLinePositions,
  mergeIdenticalLines,
  sortOrderLines,
  type MenuCategory,
  type MenuItem,
  type SelectedModifier,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  placeOrder,
  type ComboSet,
  type PlaceOrderInput,
  type PlaceOrderResult,
} from '@favornoms/database/queries';
import { Badge, Button, RiderIcon, Segmented, Sheet, useConfirm } from '@favornoms/ui';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { SignOutIconButton } from '@/components/sign-out';
import {
  changeDue,
  digitsOnly,
  quickTender,
  readNumericField,
  summariseSplit,
} from './counter-math';
import { CounterItemSheet } from './counter-item-sheet';
import { CounterComboSheet } from './counter-combo-sheet';
import { ClockButton } from './clock-button';
import { ComboArt, comboDishImages } from './combo-art';
import {
  CounterDeliveryFields,
  EMPTY_DELIVERY,
  useDeliveryHours,
  useDeliveryQuote,
  type CounterDelivery,
} from './counter-delivery';
import {
  describeCounterFailure,
  describeSettleError,
  orderMayExist,
  parsePlaceOrderFailure,
  type CounterErrorKey,
  type SettleError,
} from './counter-errors';
import { WALK_IN_PHONE, countryForTimezone, readCounterPhone } from './counter-phone';
import {
  addCounterLine,
  counterLineKey,
  counterLineSubtotals,
  lineSubtotal,
  quoteCounterCart,
  r2,
  unitPrice as priceWithOptions,
  type CounterPayMethod,
  type EffectivePrice,
} from './counter-pricing';
import { PrinterProvider, PrinterStatusButton, usePrinter } from './printer-control';
import { QrPad, type CounterQrTransfer } from './qr-pad';
import { readUnsettled, writeUnsettled, type UnsettledTransfer } from './unsettled-transfers';
import { useLiveCounter } from './use-live-counter';

export type { CounterQrTransfer } from './qr-pad';

interface Line {
  id: string;
  /** Absent on carts parked before the till could sell a combo, which were all items. */
  kind?: 'item' | 'combo';
  /** The menu item id, or for a combo line the combo_set id. */
  menuItemId: string;
  name: string;
  /** Price PLUS the chosen options when the line was added. The cart re-prices every line
   *  from the live menu (happy hour starts and ends while it sits there), so this is only
   *  the fallback for a dish that has since left the menu. */
  unitPrice: number;
  quantity: number;
  imageUrl: string | null;
  /** Chosen options. Empty for an item that has none. Absent on orders parked before
   *  the till could take them. */
  modifiers?: SelectedModifier[];
  /** Free text for the kitchen ticket. */
  notes?: string;
  /** Combo lines only: the dishes inside, for the cart and the printed ticket. */
  contents?: Array<{ name: string; quantity: number }>;
}

const isCombo = (l: Line) => l.kind === 'combo';
type Channel = 'dine_in' | 'pickup' | 'delivery' | 'qr_ordering';
type PayStep = 'choose' | 'cash' | 'qr';

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
  /** The branch's live combos. Empty for a branch that sells none. */
  combos?: ComboSet[];
  /** `card_payment` entitlement — default false so a missing prop cannot sell it. */
  canUseCard?: boolean;
  /** `delivery` entitlement — same. */
  canDeliver?: boolean;
  /** branches.sales_tax_rate as a decimal (0.0701 = 7.01%), the figure place-order taxes
   *  with. Defaults to 0 like the server does, so a missing prop can only undercharge. */
  salesTaxRate?: number;
  /** branches.settings.service_fee_percent — a card-only surcharge on the food. */
  serviceFeePercent?: number;
  /** branches.settings.delivery_fee: what place-order charges a delivery with no map pin, or
   *  one quote_delivery cannot price. A pinned address is quoted by distance instead. */
  deliveryFeeFlat?: number;
  /** THIS branch's payment QR from Branch settings -> Payment methods, or null for none. */
  qrTransfer?: CounterQrTransfer | null;
  /** branch.settings: only someone who can upload a QR is told where to do it. */
  canEditBranchSettings?: boolean;
  /** Happy-hour prices in force when the page rendered, by menu item id. */
  effectivePrices?: Record<string, EffectivePrice>;
  /** Menu item id -> when its 86 lifts. Future times only. */
  soldOutUntil?: Record<string, string>;
  /** Where the delivery map opens when nothing is pinned yet. */
  branchCenter?: { lat: number; lng: number } | null;
  /** branches.timezone: a phone number's default country, and "sold out until" times. */
  branchTimezone?: string | null;
}

type Receipt = Parameters<ReturnType<typeof usePrinter>['print']>[0];

/** What the cart pane and the payment sheet say went wrong. */
interface PayErrorState {
  message: string;
  /** A second sentence: which dish, or what to do about money already taken. */
  detail?: string | null;
  /** The machine code, for anything the till has no sentence of its own for. */
  code?: string | null;
}

/** A QR sale whose order exists but whose payment could not be recorded yet. */
type Unsettled = UnsettledTransfer<Receipt>;

type SettleOutcome = { ok: true } | { ok: false; error: SettleError };

/** Refusals that mean the menu on screen is out of date: re-read it straight away. */
const STALE_MENU_ERRORS: ReadonlySet<CounterErrorKey> = new Set([
  'itemSoldOut',
  'insufficientStock',
  'itemInactive',
  'itemNotInBranch',
  'modifierInactive',
  'comboUnavailable',
  'comboItemUnavailable',
  'staleClient',
]);

// Stable empties: a fresh `{}` default on every render would re-run the effects keyed on them.
const NO_PRICES: Record<string, EffectivePrice> = {};
const NO_SOLD_OUT: Record<string, string> = {};

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
  /** Absent on carts parked before the till asked for these. */
  customerName?: string;
  phone?: string;
  delivery?: CounterDelivery;
}

const PARK_STORAGE_KEY = (branchId: string) => `pos-parked-orders:${branchId}`;

function PosInner({
  branchId,
  branchName,
  categories,
  items,
  tables = [],
  combos = [],
  canUseCard = false,
  canDeliver = false,
  salesTaxRate = 0,
  serviceFeePercent = 0,
  deliveryFeeFlat = 0,
  qrTransfer = null,
  canEditBranchSettings = false,
  effectivePrices = NO_PRICES,
  soldOutUntil = NO_SOLD_OUT,
  branchCenter = null,
  branchTimezone = null,
}: Props) {
  const t = useTranslations('counter');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const { print, kickDrawer } = usePrinter();
  // Named askConfirm, not confirm: this component already has confirmPark and its own
  // park dialog, and a bare `confirm` here would read like one of those.
  const askConfirm = useConfirm();
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
    () => tables.find((tb) => tb.id === tableId) ?? null,
    [tables, tableId],
  );
  const [discountInput, setDiscountInput] = React.useState('');
  const [splitInput, setSplitInput] = React.useState('');
  const discountPercent = readNumericField(discountInput, { min: 0, max: 100, empty: 0 });
  const splitN = readNumericField(splitInput, { min: 1, max: 20, empty: 1 });
  const [parked, setParked] = React.useState<ParkedOrder[]>([]);
  const [showParked, setShowParked] = React.useState(false);
  const [payError, setPayError] = React.useState<PayErrorState | null>(null);
  /** The item whose options are being picked, or null. Tapping a tile no longer adds. */
  const [configuring, setConfiguring] = React.useState<MenuItem | null>(null);
  /** Choosing a tender, counting out cash, or showing the branch's QR. */
  const [payStep, setPayStep] = React.useState<PayStep>('choose');
  const [tenderedInput, setTenderedInput] = React.useState('');
  /** Change owed on the sale just completed, held until the cashier dismisses it. */
  const [changeOwed, setChangeOwed] = React.useState<number | null>(null);
  /**
   * Where the last sale rung up with a phone number was filed: under this branch's customer with
   * that number (their visits and points), or as a walk-in because no customer here has it.
   * place-order answers customer_matched only when a lookup number was sent.
   */
  const [customerFiled, setCustomerFiled] = React.useState<{ number: string; matched: boolean } | null>(null);
  /** The label being typed for a cart about to be parked, or null. */
  const [parkLabel, setParkLabel] = React.useState<string | null>(null);
  /** The combo whose quantity is being picked, or null. */
  const [configuringCombo, setConfiguringCombo] = React.useState<ComboSet | null>(null);
  /**
   * Who the order is for.
   *
   * Every counter order went in as "Walk-in" with a placeholder phone, so Recent orders was
   * a column of identical names and a pickup could not be called out to anybody.
   */
  const [customerName, setCustomerName] = React.useState('');
  /** Optional everywhere (it finds this branch's customer for points); required to deliver. */
  const [phoneInput, setPhoneInput] = React.useState('');
  const [phoneTouched, setPhoneTouched] = React.useState(false);
  const [delivery, setDelivery] = React.useState<CounterDelivery>(EMPTY_DELIVERY);
  const [deliveryTouched, setDeliveryTouched] = React.useState(false);
  /** QR sales placed but not yet recorded as paid, oldest first. Kept in this browser. */
  const [unsettled, setUnsettled] = React.useState<Unsettled[]>([]);
  const [unsettledLoaded, setUnsettledLoaded] = React.useState(false);
  /** The order whose "Record payment" is running, or null. */
  const [retryingId, setRetryingId] = React.useState<string | null>(null);
  /** Happy-hour prices. Seeded by the server render, re-read every minute on the client. */
  const [effective, setEffective] = React.useState(effectivePrices);
  React.useEffect(() => setEffective(effectivePrices), [effectivePrices]);
  // "Sold out until 5:00 PM" depends on the browser's clock and ICU, which the server's
  // render does not share; it is only written once the page is running here.
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);

  const live = useLiveCounter({ branchId, soldOutUntil, onPrices: setEffective });

  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(PARK_STORAGE_KEY(branchId));
      if (raw) setParked(JSON.parse(raw));
    } catch {
      // ignore
    }
  }, [branchId]);

  // Read after mount (the server render has no storage), and written back on every change once
  // read, so a first render's empty list can never overwrite what the last session left.
  React.useEffect(() => {
    const stored = readUnsettled<Receipt>(branchId);
    setUnsettled(stored);
    setUnsettledLoaded(true);
    if (stored.length === 0) return undefined;
    // One recorded since, from Recent orders on another screen or device, is no longer owed.
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await getBrowserClient()
          .from('orders')
          .select('id, awaiting_payment')
          .in('id', stored.map((u) => u.orderId));
        if (cancelled || !data) return;
        const paid = new Set(data.filter((o) => o.awaiting_payment === false).map((o) => o.id));
        if (paid.size > 0) setUnsettled((curr) => curr.filter((u) => !paid.has(u.orderId)));
      } catch {
        // Keep the list: "Record payment" is idempotent and clears a paid one on its own.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId]);
  React.useEffect(() => {
    if (unsettledLoaded) writeUnsettled(branchId, unsettled);
  }, [branchId, unsettled, unsettledLoaded]);

  const persistParked = (next: ParkedOrder[]) => {
    setParked(next);
    try {
      window.localStorage.setItem(PARK_STORAGE_KEY(branchId), JSON.stringify(next));
    } catch {
      // ignore quota errors
    }
  };

  const itemById = React.useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);
  const comboById = React.useMemo(() => new Map(combos.map((c) => [c.id, c])), [combos]);
  const itemImageById = React.useMemo(
    () => new Map(items.map((i) => [i.id, i.imageUrl ?? null])),
    [items],
  );

  /** A dish as the till sells it right now: the happy-hour price in `price`, the menu's
   *  beside it, and the happy hour's name. */
  const sellable = React.useCallback(
    (item: MenuItem) => {
      const eff = effective[item.id];
      return eff
        ? { item: { ...item, price: eff.price }, listPrice: item.price, label: eff.label }
        : { item, listPrice: null, label: null };
    },
    [effective],
  );

  /**
   * Whether a combo can be sold. v_active_combos works it out (every dish on sale, none 86'd,
   * enough stock for the combo's quantity) and listActiveCombos carries its flag; the dishes the
   * till holds live are checked as well, so an 86 arriving between page renders counts at once.
   */
  const comboAvailable = React.useCallback(
    (c: ComboSet) => {
      if (c.is_available === false) return false;
      return c.items.every((it) => {
        const mi = itemById.get(it.menu_item_id);
        return !!mi && !mi.outOfStock;
      });
    },
    [itemById],
  );

  /** The combo with each dish marked, so the sheet can say which one is holding it up. */
  const withDishAvailability = React.useCallback(
    (c: ComboSet): ComboSet => ({
      ...c,
      items: c.items.map((it) => {
        const mi = itemById.get(it.menu_item_id);
        return { ...it, is_available: it.is_available !== false && !!mi && !mi.outOfStock };
      }),
    }),
    [itemById],
  );

  const untilFormat = React.useMemo(() => {
    const make = (opts: Intl.DateTimeFormatOptions) => {
      try {
        return new Intl.DateTimeFormat(intlLocaleFor(locale), {
          ...opts,
          timeZone: branchTimezone ?? undefined,
        });
      } catch {
        // A timezone this browser does not know: its own clock is the next best thing.
        return new Intl.DateTimeFormat(intlLocaleFor(locale), opts);
      }
    };
    return {
      today: make({ hour: 'numeric', minute: '2-digit' }),
      later: make({ weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    };
  }, [locale, branchTimezone]);
  const soldOutText = (itemId: string) => {
    const iso = soldOutUntil[itemId];
    if (!mounted || !iso) return t('menu.soldOut');
    const at = new Date(iso);
    if (!Number.isFinite(at.getTime())) return t('menu.soldOut');
    const far = at.getTime() - Date.now() > 20 * 60 * 60 * 1000;
    return t('menu.soldOutUntil', { time: (far ? untilFormat.later : untilFormat.today).format(at) });
  };

  // Only a suggestion the cashier can overwrite, kept in this browser: it is never sent to
  // the server, so it is written in the language on screen.
  const suggestedParkLabel = () =>
    tableNumber
      ? t('tableLabel', { number: tableNumber })
      : t('park.defaultTime', { time: new Date().toLocaleTimeString(intlLocaleFor(locale)) });

  /** Everything about the customer and the money, back to a fresh sale. */
  const resetSale = () => {
    setLines([]);
    setCustomerName('');
    setPhoneInput('');
    setPhoneTouched(false);
    setDelivery(EMPTY_DELIVERY);
    setDeliveryTouched(false);
    setTableNumber('');
    setTableId(null);
    setDiscountInput('');
    setSplitInput('');
  };

  /**
   * Park used to ask for its label with window.prompt, which Chrome refuses outright in a
   * sandboxed frame and which any browser will suppress once a user ticks "prevent this
   * page from creating more dialogs". It THROWS there rather than returning null, so the
   * button did nothing at all and said nothing about why -- with a customer's order in the
   * cart. This opens the app's own dialog instead.
   */
  const parkCurrent = () => {
    if (lines.length === 0) return;
    setParkLabel(suggestedParkLabel());
  };

  const confirmPark = () => {
    if (lines.length === 0 || parkLabel === null) return;
    const suggested = suggestedParkLabel();
    const next: ParkedOrder = {
      id: `parked-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      label: parkLabel.trim() || suggested,
      lines: lines.slice(),
      channel,
      tableNumber,
      parkedAt: new Date().toISOString(),
      customerName,
      phone: phoneInput,
      delivery,
    };
    persistParked([next, ...parked]);
    setParkLabel(null);
    resetSale();
  };

  const resumeParked = async (parkedId: string) => {
    const target = parked.find((p) => p.id === parkedId);
    if (!target) return;
    if (lines.length > 0) {
      if (
        !(await askConfirm({
          title: t('parked.replaceTitle'),
          body: t('parked.replaceBody'),
          confirmLabel: t('parked.replaceConfirm'),
          destructive: true,
        }))
      ) {
        return;
      }
    }
    // Folded to one line per selection, the way place-order will bill it: a cart parked by an
    // older build can hold the same dish twice.
    setLines(mergeIdenticalLines(target.lines, counterLineKey));
    // Parked orders live in localStorage indefinitely, so one can outlive delivery at
    // this branch (it is switched on branch by branch now). Fall back to pickup rather
    // than resuming into a channel place-order will refuse with a 403.
    setChannel(target.channel === 'delivery' && !canDeliver ? 'pickup' : target.channel);
    setTableNumber(target.tableNumber);
    // Re-resolved from the current floor rather than carried in the parked order: a cart
    // parked before lunch can be resumed after the table it named was renumbered or retired.
    setTableId(tables.find((tb) => tb.number === target.tableNumber)?.id ?? null);
    setCustomerName(target.customerName ?? '');
    setPhoneInput(target.phone ?? '');
    setDelivery(target.delivery ?? EMPTY_DELIVERY);
    persistParked(parked.filter((p) => p.id !== parkedId));
    setShowParked(false);
  };

  const discardParked = async (parkedId: string) => {
    if (
      !(await askConfirm({
        title: t('parked.discardTitle'),
        body: t('parked.discardBody'),
        confirmLabel: t('parked.discardConfirm'),
        destructive: true,
      }))
    ) {
      return;
    }
    persistParked(parked.filter((p) => p.id !== parkedId));
  };

  const filtered = React.useMemo(() => {
    const q = search.trim().toLowerCase();
    // 'combos' is a pseudo-category: combos are not menu items and have no category_id, so
    // picking it hides the item grid entirely rather than filtering it.
    if (activeCategory === 'combos') return [];
    return items.filter((i) => {
      if (activeCategory !== 'all' && i.categoryId !== activeCategory) return false;
      if (!q) return true;
      return i.name.toLowerCase().includes(q);
    });
  }, [items, activeCategory, search]);

  const visibleCombos = React.useMemo(() => {
    if (combos.length === 0) return [];
    if (activeCategory !== 'all' && activeCategory !== 'combos') return [];
    const q = search.trim().toLowerCase();
    return q ? combos.filter((c) => c.name.toLowerCase().includes(q)) : combos;
  }, [combos, activeCategory, search]);

  /**
   * The cart at today's prices. A line keeps the price it was added at only as a fallback:
   * happy hour starting or ending while a cart sits open would otherwise have the till quote
   * one figure and place-order charge another.
   */
  const pricedLines = React.useMemo(
    () =>
      lines.map((l) => {
        let unit = l.unitPrice;
        if (isCombo(l)) {
          const combo = comboById.get(l.menuItemId);
          if (combo) unit = r2(combo.total_price);
        } else {
          const item = itemById.get(l.menuItemId);
          if (item) unit = priceWithOptions(effective[item.id]?.price ?? item.price, l.modifiers);
        }
        return unit === l.unitPrice ? l : { ...l, unitPrice: unit };
      }),
    [lines, comboById, itemById, effective],
  );

  /**
   * The cart in menu order, category by category with the combos first (as the tiles show them),
   * the way the receipt, the kitchen ticket and the bill will list the order. Display only:
   * `lines` keeps the order things were rung up in.
   */
  const positionOf = React.useMemo(
    () => menuLinePositions({ categories, items, combos }),
    [categories, items, combos],
  );
  const menuOrderedLines = React.useMemo(
    () =>
      sortOrderLines(pricedLines, (l) => ({
        ...positionOf(isCombo(l) ? { comboId: l.menuItemId } : { menuItemId: l.menuItemId }),
        item_name: l.name,
        modifiers: l.modifiers,
      })),
    [pricedLines, positionOf],
  );

  /**
   * Why a line in the cart cannot be sold any more, or null. Live updates grey the tiles, but a
   * dish added before the kitchen 86'd it used to ride all the way to Charge, and for a QR sale
   * past the customer's transfer, before place-order refused it.
   */
  const lineProblem = (l: Line): string | null => {
    if (isCombo(l)) {
      const combo = comboById.get(l.menuItemId);
      if (!combo) return t('cart.lineGone');
      return comboAvailable(combo) ? null : t('menu.soldOut');
    }
    const item = itemById.get(l.menuItemId);
    if (!item) return t('cart.lineGone');
    return item.outOfStock ? soldOutText(item.id) : null;
  };
  const unsellableLines = lines.filter((l) => lineProblem(l) !== null).length;

  // Delivery: the pinned address's own fee from quote_delivery, or place-order's flat one.
  const isDelivery = channel === 'delivery';
  const deliveryQuote = useDeliveryQuote(branchId, delivery.pin, isDelivery);
  // Delivery hours: the orders insert trigger refuses a delivery outside them, and for a QR sale
  // that refusal would come after the customer has paid.
  const deliveryHours = useDeliveryHours(branchId, isDelivery);
  const deliveryFee = !isDelivery
    ? 0
    : deliveryQuote.status === 'ok'
      ? deliveryQuote.fee
      : deliveryFeeFlat;

  const phoneCountry = React.useMemo(() => countryForTimezone(branchTimezone), [branchTimezone]);
  const phone = readCounterPhone(phoneInput, phoneCountry);

  // What place-order will price this cart at, per payment method: its own arithmetic, in its
  // own order (counter-pricing.ts). The service fee is card-only, so Cash and Card are
  // genuinely different amounts and both are named rather than one standing in for the other.
  const quoteFor = React.useCallback(
    (method: CounterPayMethod) =>
      quoteCounterCart({
        // Lines of one selection priced as the one line place-order bills them as.
        ...counterLineSubtotals(pricedLines),
        discountPercent,
        salesTaxRate,
        serviceFeePercent,
        deliveryFee,
        method,
      }),
    [pricedLines, discountPercent, salesTaxRate, serviceFeePercent, deliveryFee],
  );
  const cashQuote = quoteFor('cash');
  const cardQuote = quoteFor('card');
  const transferQuote = quoteFor('transfer');
  const total = cashQuote.total;
  // Was Math.ceil(total / splitN) -- a round UP TO THE DOLLAR, so a $4.82 bill split
  // four ways asked each of four people for $2.00 and collected $8.00. summariseSplit
  // works in cents and its parts add back up to the total exactly.
  const split = React.useMemo(() => summariseSplit(total, splitN), [total, splitN]);

  // Charge stays shut until place-order could accept the sale: a delivery needs somewhere to
  // go and someone the rider can call, and a number typed wrong is better fixed now than
  // stored against the wrong customer.
  const phoneInvalid = phone.state === 'invalid';
  const deliveryMissing = isDelivery && (phone.state !== 'valid' || !delivery.line1.trim());
  const deliveryRefused =
    isDelivery &&
    (deliveryQuote.status === 'out_of_range' ||
      deliveryQuote.status === 'not_entitled' ||
      deliveryHours.status === 'closed');
  const chargeBlocked =
    lines.length === 0 ||
    unsellableLines > 0 ||
    phoneInvalid ||
    deliveryMissing ||
    deliveryRefused ||
    (isDelivery && deliveryQuote.status === 'loading');
  /** Why Charge is shut, in words, for the line above it and for a tap that races it. */
  const chargeHint =
    lines.length === 0
      ? null
      : unsellableLines > 0
        ? t('cart.unsellableHint', { count: unsellableLines })
        : phoneInvalid
          ? t('cart.phoneInvalid')
          : deliveryMissing
            ? t('delivery.needsDetails')
            : isDelivery && deliveryHours.status === 'closed'
              ? t('errors.deliveryNotAvailableNow')
              : isDelivery && deliveryQuote.status === 'out_of_range'
                ? t('errors.deliveryOutOfRange')
                : null;
  // payments.amount must be above zero, so a sale discounted to nothing gets no payment row: a
  // card or QR sale then has nothing to settle, and a QR one would sit in "awaiting payment" for
  // good. A comp goes through Cash, and settle() confirms it with nothing to record.
  const offerCard = canUseCard && cardQuote.total > 0;
  const offerQr = !!qrTransfer && transferQuote.total > 0;

  /**
   * Add what the sheet was configured with.
   *
   * Merging is keyed on the item AND its options (in any order) AND its trimmed note, not the
   * item alone (counterLineKey, the key place-order bills on). With options in play the old key
   * is actively wrong: a plain burger and a burger with bacon would have collapsed into one
   * line at one of the two prices.
   */
  const addConfigured = React.useCallback(
    (args: {
      item: MenuItem;
      quantity: number;
      notes: string;
      modifiers: SelectedModifier[];
      unitPrice: number;
    }) => {
      const { item, quantity, notes, modifiers, unitPrice } = args;
      setLines((curr) =>
        addCounterLine<Line>(curr, {
          id: `${item.id}-${Date.now()}-${curr.length}`,
          menuItemId: item.id,
          name: item.name,
          unitPrice,
          imageUrl: item.imageUrl,
          quantity,
          modifiers,
          notes: notes.trim() || undefined,
        }),
      );
    },
    [],
  );

  /**
   * Add a combo to the cart.
   *
   * Keyed on the combo AND its note for the same reason items are: two of the same deal
   * with different kitchen notes are two different tickets.
   */
  const addCombo = React.useCallback(
    (args: { combo: ComboSet; quantity: number; notes: string }) => {
      const { combo, quantity, notes } = args;
      setLines((curr) =>
        addCounterLine<Line>(curr, {
          id: `combo-${combo.id}-${Date.now()}-${curr.length}`,
          kind: 'combo' as const,
          menuItemId: combo.id,
          name: combo.name,
          unitPrice: combo.total_price,
          imageUrl: combo.image_url,
          quantity,
          notes: notes.trim() || undefined,
          contents: combo.items.map((it) => ({ name: it.item_name, quantity: it.quantity })),
        }),
      );
    },
    [],
  );

  // Held to MAX_LINE_QUANTITY: place-order refuses the whole sale for a line above it, with a
  // message that cannot say which line.
  const updateQty = (lineId: string, delta: number) => {
    setLines((curr) =>
      curr
        .map((l) =>
          l.id === lineId
            ? { ...l, quantity: Math.min(MAX_LINE_QUANTITY, Math.max(0, l.quantity + delta)) }
            : l,
        )
        .filter((l) => l.quantity > 0),
    );
  };

  const clear = () => setLines([]);

  const closePay = () => {
    setPayOpen(false);
    setPayStep('choose');
    setTenderedInput('');
  };

  // Hotkeys: digits 1-9 OPEN the Nth visible menu item (Enter in the sheet adds it, so the
  // two-keystroke path is still faster than reaching for the screen); Esc closes a sheet;
  // Ctrl+P opens payment sheet when there's a cart. A sold-out item still takes up its
  // number — the digits have to keep matching the positions the cashier can see — but
  // pressing it does nothing, so the keyboard cannot reach a tile the finger cannot.
  React.useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') {
        setPayOpen(false);
        setPayStep('choose');
        setTenderedInput('');
        setConfiguring(null);
        setConfiguringCombo(null);
        return;
      }
      if ((e.key === 'p' || e.key === 'P') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (!chargeBlocked) setPayOpen(true);
        return;
      }
      const idx = Number(e.key);
      if (Number.isInteger(idx) && idx >= 1 && idx <= 9) {
        const target = filtered[idx - 1];
        if (target && !target.outOfStock) setConfiguring(target);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [filtered, chargeBlocked]);

  /** Why place-order refused, as a sentence, plus which dish and the code when it helps. */
  const describeRefusal = (raw: string, method: CounterPayMethod): PayErrorState => {
    const failure = parsePlaceOrderFailure(raw);
    const desc = describeCounterFailure(failure);
    if (desc.key === 'unknown' || desc.key === 'orderInsertFailed' || desc.key === 'lookupFailed') {
      console.error('counter: place order failed', raw);
    }
    if (STALE_MENU_ERRORS.has(desc.key)) {
      live.refresh();
      void live.reloadPrices();
    }
    const name =
      (desc.itemId ? itemById.get(desc.itemId)?.name : null) ??
      (desc.comboId ? comboById.get(desc.comboId)?.name : null) ??
      null;
    const details: string[] = [];
    if (name) {
      details.push(
        desc.available != null
          ? t('errors.onlyLeft', { name, count: desc.available })
          : t('errors.which', { name }),
      );
    }
    // Only a refusal place-order spelled out proves there is no order. After a dropped answer or
    // a server error page the sale may well exist, and ringing it up again makes a second one.
    if (orderMayExist(failure)) {
      details.push(t(method === 'transfer' ? 'errors.transferMaybePlaced' : 'errors.maybePlaced'));
    } else if (method === 'transfer') {
      // The customer has already sent the money from their banking app.
      details.push(t('errors.transferNoOrder'));
    }
    return {
      message: t(`errors.${desc.key}`),
      detail: details.join(' ') || null,
      code: desc.code,
    };
  };

  /**
   * Record the money as taken. Cash and card go through record_counter_payment; a QR transfer
   * through record_counter_transfer, the cashier having just looked at the customer's banking
   * app. Both re-read the order's own total and stamp who took it.
   */
  const settle = async (
    orderId: string,
    method: CounterPayMethod,
    opts: { tendered?: number; nothingToCollect?: boolean } = {},
  ): Promise<SettleOutcome> => {
    const supabase = getBrowserClient();
    if (method === 'transfer') {
      // No fallback. orders_block_unpaid_transfer refuses to move an order whose transfer is
      // unpaid, and a status write that did get through would put an unpaid order on the
      // kitchen board. The order waits in "awaiting payment" until this succeeds.
      try {
        const { error } = await supabase.rpc('record_counter_transfer', { p_order_id: orderId });
        if (!error) return { ok: true };
        console.error('counter: record_counter_transfer failed', error.message);
        return { ok: false, error: describeSettleError(error.message) };
      } catch (err) {
        return { ok: false, error: describeSettleError((err as Error)?.message) };
      }
    }
    const { error } = await supabase.rpc('record_counter_payment', {
      p_order_id: orderId,
      p_tendered: method === 'cash' ? opts.tendered : undefined,
    });
    if (!error) return { ok: true };
    // A sale discounted to nothing has no payment row (payments.amount must be above zero), so
    // there is nothing to record: confirming the order is the whole of settling it.
    const nothingRecorded = opts.nothingToCollect === true && error.message.includes('payment_not_found');
    if (!nothingRecorded) console.error('counter: record_counter_payment failed', error.message);
    // The RPC also promotes a card sale out of 'pending'. If it could not run, the ticket
    // still has to reach the kitchen, so fall back to the plain status write.
    const { error: statusErr } = await supabase
      .from('orders')
      .update({ status: 'confirmed' })
      .eq('id', orderId)
      .eq('status', 'pending');
    return nothingRecorded && !statusErr
      ? { ok: true }
      : { ok: false, error: describeSettleError(error.message) };
  };

  const announce = (orderNumber: string) => {
    setSuccess(orderNumber);
    setTimeout(() => setSuccess(null), 4000);
  };

  const handlePay = async (method: CounterPayMethod, tendered?: number) => {
    if (submitting) return;
    if (chargeBlocked) {
      // The cart changed under the open sheet (a dish 86'd while the QR was up, delivery hours
      // ending): say so, rather than a "Payment received" that silently does nothing.
      setPayError({ message: chargeHint ?? t('errors.generic') });
      return;
    }
    setSubmitting(true);
    setPayError(null);
    setCustomerFiled(null);
    // In menu order: the printed receipt lists the lines the way the bill and the kitchen do.
    const snapshotLines = menuOrderedLines;
    const expected = quoteFor(method);
    const name = customerName.trim();
    const supabase = getBrowserClient();

    const payload: PlaceOrderInput = {
      branch_id: branchId,
      channel,
      // A typed name wins over the table, and the table over nothing: Recent orders and
      // the pickup shout-out both read this field. The fallbacks are stored data, so they
      // stay in English whatever language the till is showing.
      customer_name: name || (tableNumber ? `Table ${tableNumber}` : 'Walk-in'),
      // place-order needs a number on every order. The customer's own goes in only where the
      // rider has to call it; everywhere else the placeholder, which is never anybody's. A
      // place-order older than customer_lookup_phone filed a real number here under the
      // CASHIER's customer record (creating one on their first such sale), so the number
      // typed "for points" travels only in the lookup field, which is read and never written.
      customer_phone: isDelivery && phone.e164 ? phone.e164 : WALK_IN_PHONE,
      ...(phone.e164 ? { customer_lookup_phone: phone.e164 } : {}),
      customer_notes: tableNumber ? `Table ${tableNumber}` : undefined,
      // Staff surface: place-order exempts it from the storefront's
      // dine-in-needs-a-table rule, since the counter rings up walk-ins.
      source: 'counter',
      table_id: tableId ?? undefined,
      table_number: tableNumber || undefined,
      payment_method: method,
      // place-order takes it off the food before tax and the card fee, and records it on the
      // order. The till used to take it off afterwards and overwrite orders.total from the
      // browser, which left tax charged on money nobody paid.
      ...(discountPercent > 0 ? { discount_percent: discountPercent } : {}),
      // A counter delivery had no address at all, and place-order refused every one of them
      // with delivery_address_required. The cashier hands the order over to a rider who will
      // phone the customer, so the drop-off is "hand it to me".
      ...(isDelivery
        ? {
            delivery_address: {
              line1: delivery.line1.trim(),
              notes: delivery.notes.trim() || undefined,
              lat: delivery.pin?.lat,
              lng: delivery.pin?.lng,
              dropoff_pref: 'hand_to_me' as const,
            },
          }
        : {}),
      // The options and the note travel with the line. place-order has always accepted
      // both; the till simply never sent them, so every counter ticket reached the
      // kitchen stripped of whatever the customer actually asked for.
      items: lines
        .filter((l) => !isCombo(l))
        .map((l) => ({
          menu_item_id: l.menuItemId,
          quantity: l.quantity,
          notes: l.notes,
          modifier_option_ids: l.modifiers?.map((m) => m.option_id),
        })),
      // place-order prices a combo from combo_sets.total_price and refuses one that is
      // not this branch's or no longer active, so the till sends the id and the count and
      // nothing else.
      combos: lines
        .filter(isCombo)
        .map((l) => ({ combo_id: l.menuItemId, quantity: l.quantity, notes: l.notes })),
    };

    let result: PlaceOrderResult;
    try {
      result = await placeOrder(supabase, payload);
    } catch (err) {
      // A cashier mid-sale needs the reason, not a raw wire string in a browser alert().
      // Suspension makes place-order refuse every new order here, and the fix for that one
      // is on the Plan page, not at the till.
      const billing = describeBillingError(err);
      setPayError(
        billing
          ? {
              message: billingErrorMessage(billing, locale),
              // A plan refusal is always answered before the order exists.
              detail: method === 'transfer' ? t('errors.transferNoOrder') : null,
            }
          : describeRefusal((err as Error)?.message ?? String(err), method),
      );
      setSubmitting(false);
      return;
    }

    // Said as soon as the order exists, whatever settling it does next: the number typed "for
    // points" only helps if the cashier can tell it found somebody.
    if (typeof result.customer_matched === 'boolean') {
      setCustomerFiled({ number: result.order_number, matched: result.customer_matched });
    }

    try {
      // Everything past this point settles an order that already exists, so a failure here
      // is never "the sale did not happen", and the cart is cleared whatever happens --
      // ringing it up again would charge the customer twice.
      //
      // place-order is the only thing that prices an order, so the row is the truth the
      // paper has to match. It is read as an assertion on the quote the cashier just showed
      // the customer, and a disagreement means no receipt: no paper beats wrong paper.
      const { data: priced } = await supabase
        .from('orders')
        .select('subtotal, discount_amount, delivery_fee, service_fee, tax_amount, total')
        .eq('id', result.order_id)
        .maybeSingle();
      const chargedTotal = priced ? Number(priced.total) : Number(result.total);
      // A place-order that predates discount_percent ignores it and charges full price.
      const discountDropped =
        expected.discount > 0 &&
        !!priced &&
        Number(priced.discount_amount ?? 0) < expected.discount - 0.005;
      const quoteMismatch = Math.abs(chargedTotal - expected.total) > 0.005;

      const receipt: Receipt = {
        branchName,
        orderNumber: result.order_number,
        channel,
        createdAt: new Date().toISOString(),
        items: snapshotLines.map((l) => ({
          name: l.name,
          quantity: l.quantity,
          // Already the price with options in it, to four decimals. The line is printed as
          // place-order charged it (rounded once), which is what keeps the lines matching the
          // Subtotal printed below them: 7 × $7.995 is $55.97, never 7 × $8.00.
          unit_price: l.unitPrice,
          line_total: lineSubtotal(l.unitPrice, l.quantity),
          notes:
            [
              l.modifiers?.length ? l.modifiers.map((m) => m.option_name).join(', ') : null,
              // A combo prints as one priced line, so the dishes inside it have nowhere
              // else to go; without this the customer's paper says "Burger Combo Deal"
              // and nothing about what they are owed.
              l.contents?.length
                ? l.contents.map((c) => `${c.quantity}× ${c.name}`).join(', ')
                : null,
              l.notes ?? null,
            ]
              .filter(Boolean)
              .join(' · ') || null,
        })),
        subtotal: priced ? Number(priced.subtotal) : expected.subtotal,
        deliveryFee: (priced ? Number(priced.delivery_fee) : expected.deliveryFee) || undefined,
        serviceFee: (priced ? Number(priced.service_fee) : expected.serviceFee) || undefined,
        discount: (priced ? Number(priced.discount_amount) : expected.discount) || undefined,
        taxAmount: (priced ? Number(priced.tax_amount) : expected.tax) || undefined,
        total: chargedTotal,
        paymentMethod: method,
        customerName: name || null,
        customerPhone: isDelivery ? phone.e164 : null,
        customerAddress: isDelivery
          ? [delivery.line1.trim(), delivery.notes.trim()].filter(Boolean).join(' — ')
          : null,
        // ReceiptInput has carried this field all along and the till never filled it, so a
        // cash receipt printed no record of what was handed over or given back.
        cashTendered: method === 'cash' ? tendered : undefined,
      };

      const outcome = await settle(result.order_id, method, {
        tendered,
        nothingToCollect: chargedTotal <= 0,
      });
      const settled = outcome.ok;
      resetSale();
      closePay();

      const number = result.order_number;
      const wrongPaper = discountDropped || quoteMismatch;
      if (!outcome.ok && method === 'transfer') {
        // The order is waiting in "awaiting payment", off the kitchen board, until the
        // payment is recorded. Kept on screen, and in this browser, with a button that tries
        // again -- the RPC is idempotent, so a second tap can never settle it twice.
        const entry: Unsettled = {
          orderId: result.order_id,
          orderNumber: number,
          placedAt: new Date().toISOString(),
          receipt: wrongPaper ? null : receipt,
          error: outcome.error,
        };
        setUnsettled((curr) => [...curr.filter((u) => u.orderId !== entry.orderId), entry]);
      }
      if (wrongPaper) {
        // A happy hour that started or ended between the quote and the order is the usual
        // cause; the next quote should not repeat it.
        void live.reloadPrices();
        const amounts = { quoted: formatCurrency(expected.total), priced: formatCurrency(chargedTotal) };
        setPayError({
          message: discountDropped
            ? t('pay.placedDiscountFailed', { number, ...amounts })
            : t('pay.placedQuoteMismatch', { number, ...amounts }),
          detail: !settled && method !== 'transfer' ? t('pay.placedNotSettled', { number }) : null,
        });
        return;
      }
      if (!settled && method === 'transfer') return;
      if (!settled) setPayError({ message: t('pay.placedNotSettled', { number }) });

      announce(number);
      // Held until dismissed, not for four seconds: the cashier is counting notes out of a
      // drawer and the number has to still be there when they look up.
      setChangeOwed(method === 'cash' && tendered != null ? changeDue(tendered, chargedTotal) : null);
      // Fire-and-forget receipt print + cash drawer kick on cash payments
      void print(receipt);
      if (method === 'cash') void kickDrawer();
    } finally {
      setSubmitting(false);
    }
  };

  /** "Record payment" again on a QR sale whose order exists but whose payment did not stick. */
  const retrySettle = async (entry: Unsettled) => {
    if (retryingId) return;
    setRetryingId(entry.orderId);
    try {
      const outcome = await settle(entry.orderId, 'transfer');
      if (!outcome.ok) {
        setUnsettled((curr) =>
          curr.map((u) => (u.orderId === entry.orderId ? { ...u, error: outcome.error } : u)),
        );
        return;
      }
      setUnsettled((curr) => curr.filter((u) => u.orderId !== entry.orderId));
      announce(entry.orderNumber);
      if (entry.receipt) void print(entry.receipt);
    } finally {
      setRetryingId(null);
    }
  };

  /** Hide one from the till. The order itself stays payable from Recent orders. */
  const dismissUnsettled = (orderId: string) =>
    setUnsettled((curr) => curr.filter((u) => u.orderId !== orderId));

  const pricedConfiguring = configuring
    ? sellable(itemById.get(configuring.id) ?? configuring)
    : null;
  const liveConfiguringCombo = configuringCombo
    ? withDishAvailability(comboById.get(configuringCombo.id) ?? configuringCombo)
    : null;

  return (
    <div className="flex h-dynamic-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b border-border/60 bg-card px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="grid h-10 w-10 place-items-center rounded-xl bg-gradient-warm text-white shadow-warm">
            <Store className="h-5 w-5" />
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('header.eyebrow', { branch: branchName })}</p>
            <h1 className="font-display text-lg font-bold">{t('header.title')}</h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="hidden items-center gap-3 md:flex">
            <ClockButton branchId={branchId} />
            <button
              type="button"
              onClick={() => setShowParked((s) => !s)}
              className="focus-ring relative inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
            >
              {t('header.parked', { count: parked.length })}
            </button>
            <button
              type="button"
              onClick={parkCurrent}
              disabled={lines.length === 0}
              className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold disabled:opacity-40 hover:bg-muted/70"
            >
              {t('header.park')}
            </button>
            <a
              href={`/counter/${branchId}/tables`}
              className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
            >
              {t('header.tables')} →
            </a>
            <a
              href={`/counter/${branchId}/recent`}
              className="focus-ring inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-xs font-semibold hover:bg-muted/70"
            >
              {t('header.recent')} →
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
                { value: 'dine_in', label: t('channel.dine_in'), icon: <Store className="h-4 w-4" /> },
                { value: 'pickup', label: t('channel.pickup'), icon: <ShoppingBag className="h-4 w-4" /> },
                ...(canDeliver
                  ? [{ value: 'delivery', label: t('channel.delivery'), icon: <RiderIcon className="h-4 w-4" /> }]
                  : []),
              ]}
            />
          </div>
          <LocaleSwitcher compact />
          {/* A cashier has no back office, so the till is the only place to sign out. */}
          <SignOutIconButton className="border border-border bg-card text-danger hover:bg-danger/10" />
        </div>
      </header>

      {showParked && (
        <div className="border-b border-border/60 bg-muted/40 px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold">{t('parked.title', { count: parked.length })}</h3>
            <button
              type="button"
              onClick={() => setShowParked(false)}
              className="focus-ring rounded-full p-1 text-muted-foreground hover:bg-muted"
              aria-label={t('parked.close')}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {parked.length === 0 ? (
            <p className="mt-2 text-xs text-muted-foreground">{t('parked.empty')}</p>
          ) : (
            <ul className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {parked.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-2 rounded-xl border border-border bg-card px-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-semibold">{p.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {t('parked.meta', {
                        count: p.lines.length,
                        time: new Date(p.parkedAt).toLocaleTimeString(intlLocaleFor(locale)),
                      })}
                    </p>
                  </div>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => void resumeParked(p.id)}
                      className="focus-ring rounded-lg bg-primary px-2 py-1 text-xs font-semibold text-primary-foreground"
                    >
                      {t('parked.resume')}
                    </button>
                    <button
                      type="button"
                      onClick={() => void discardParked(p.id)}
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
                placeholder={t('menu.search')}
                className="focus-ring h-11 w-full rounded-full border border-border bg-card pl-10 pr-4 text-base"
              />
            </div>
            <button
              onClick={() => setActiveCategory('all')}
              className={`focus-ring inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
                activeCategory === 'all' ? 'border-primary bg-primary text-primary-foreground' : 'border-border bg-card'
              }`}
            >
              {t('menu.all')}
            </button>
            {combos.length > 0 && (
              <button
                onClick={() => setActiveCategory('combos')}
                className={`focus-ring inline-flex h-10 items-center gap-2 rounded-full border px-3 text-sm font-semibold ${
                  activeCategory === 'combos'
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card'
                }`}
              >
                <span aria-hidden>🎁</span> {t('menu.combos')}
              </button>
            )}
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
            {/* Above the dishes, not mixed into them: a combo is a different kind of thing
                and it is the one a customer asks for by the name on the poster. */}
            {visibleCombos.length > 0 && (
              <div className="mb-4">
                <h2 className="text-muted-foreground mb-2 text-xs font-semibold uppercase tracking-wider">
                  {t('menu.combos')}
                </h2>
                <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                  {visibleCombos.map((c) => {
                    const available = comboAvailable(c);
                    return (
                      <motion.button
                        key={c.id}
                        // Same rule as a dish: a deal with a dish 86'd or out of stock cannot
                        // be sold, and place-order would refuse it at Charge.
                        disabled={!available}
                        whileTap={available ? { scale: 0.96 } : undefined}
                        onClick={() => setConfiguringCombo(c)}
                        aria-label={available ? undefined : t('menu.soldOutAria', { name: c.name })}
                        className={`focus-ring border-primary/40 overflow-hidden rounded-2xl border bg-card text-left shadow-soft transition-shadow ${
                          available ? 'hover:shadow-warm' : 'cursor-not-allowed opacity-50 grayscale'
                        }`}
                      >
                        <div className="relative aspect-square overflow-hidden">
                          <ComboArt
                            combo={c}
                            dishImages={comboDishImages(c, itemImageById)}
                            sizes="(max-width:640px) 50vw, 20vw"
                          />
                          {!available && (
                            <span className="absolute inset-0 grid place-items-center bg-background/70">
                              <Badge variant="neutral" className="text-xs">
                                {t('menu.soldOut')}
                              </Badge>
                            </span>
                          )}
                        </div>
                        <div className="p-2.5">
                          <p className="line-clamp-2 text-sm font-semibold leading-tight">{c.name}</p>
                          <p className="font-display text-primary mt-0.5 text-base font-bold">
                            {formatCurrency(c.total_price)}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {t('menu.comboItems', { count: c.items.length })}
                          </p>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </div>
            )}
            {filtered.length === 0 && visibleCombos.length === 0 ? (
              <div className="grid place-items-center py-20 text-center">
                <div>
                  <Utensils className="mx-auto h-10 w-10 text-muted-foreground" />
                  <p className="mt-2 text-muted-foreground">{t('menu.noMatch')}</p>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
                {filtered.map((raw) => {
                  const { item, listPrice } = sellable(raw);
                  const soldOut = !!item.outOfStock;
                  return (
                    <motion.button
                      key={item.id}
                      // A sold-out tile used to look and tap exactly like a live one, and the
                      // cashier only found out at the item sheet, or worse at Charge. Disabled
                      // rather than merely dimmed: on a touch till a grey tile still gets tapped.
                      disabled={soldOut}
                      whileTap={soldOut ? undefined : { scale: 0.96 }}
                      onClick={() => setConfiguring(raw)}
                      aria-label={soldOut ? t('menu.soldOutAria', { name: item.name }) : undefined}
                      className={`focus-ring overflow-hidden rounded-2xl bg-card text-left shadow-soft transition-shadow ${
                        soldOut ? 'cursor-not-allowed opacity-50 grayscale' : 'hover:shadow-warm'
                      }`}
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
                        {soldOut && (
                          <span className="absolute inset-0 grid place-items-center bg-background/70 p-2 text-center">
                            <Badge variant="neutral" className="text-xs">
                              {soldOutText(item.id)}
                            </Badge>
                          </span>
                        )}
                      </div>
                      <div className="p-2.5">
                        <p className="line-clamp-2 text-sm font-semibold leading-tight">{item.name}</p>
                        <p className="mt-0.5 font-display text-base font-bold text-primary">
                          {formatUnitPrice(item.price)}
                          {/* Happy hour: the till says so, because the customer is looking at
                              the menu board's price while the cashier reads this one out. */}
                          {listPrice != null && (
                            <span className="text-muted-foreground ml-1.5 text-xs font-normal line-through">
                              {formatUnitPrice(listPrice)}
                            </span>
                          )}
                        </p>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Right — cart pane */}
        <aside className="flex w-[360px] flex-col border-l border-border/60 bg-card">
          <div className="flex items-center justify-between border-b border-border/60 px-5 py-3">
            <h2 className="font-display text-lg font-semibold">{t('cart.title')}</h2>
            {lines.length > 0 && (
              <button
                onClick={clear}
                className="focus-ring inline-flex items-center gap-1 text-sm font-medium text-danger"
              >
                <Trash2 className="h-4 w-4" /> {t('cart.clear')}
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {lines.length === 0 ? (
              <div className="grid h-full place-items-center text-center">
                <div>
                  <ShoppingBag className="mx-auto h-10 w-10 text-muted-foreground" />
                  <p className="mt-2 text-sm text-muted-foreground">{t('cart.empty')}</p>
                </div>
              </div>
            ) : (
              <ul className="space-y-2">
                <AnimatePresence>
                  {menuOrderedLines.map((line) => {
                    const problem = lineProblem(line);
                    return (
                    <motion.li
                      key={line.id}
                      layout
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, x: -10 }}
                      className={`flex items-center gap-3 rounded-xl border p-2 ${
                        problem ? 'border-danger/60 bg-danger/5' : 'border-border/60'
                      }`}
                    >
                      <div className="flex-1 min-w-0">
                        <p className="line-clamp-1 text-sm font-semibold">{line.name}</p>
                        {problem && (
                          <p className="text-danger text-xs font-semibold">{problem}</p>
                        )}
                        {/* What was picked, on the line itself: a cashier reading the order
                            back has to be able to see it without opening anything. */}
                        {line.modifiers && line.modifiers.length > 0 && (
                          <p className="text-muted-foreground line-clamp-2 text-xs">
                            {line.modifiers.map((m) => m.option_name).join(', ')}
                          </p>
                        )}
                        {line.contents && line.contents.length > 0 && (
                          <p className="text-muted-foreground line-clamp-2 text-xs">
                            {line.contents.map((c) => `${c.quantity}× ${c.name}`).join(', ')}
                          </p>
                        )}
                        {line.notes && (
                          <p className="text-warning line-clamp-2 text-xs">{line.notes}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {t('cart.each', { price: formatUnitPrice(line.unitPrice) })}
                        </p>
                      </div>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => updateQty(line.id, -1)}
                          className="focus-ring grid h-8 w-8 place-items-center rounded-full bg-muted"
                          aria-label={t('cart.decrease')}
                        >
                          <Minus className="h-3.5 w-3.5" />
                        </button>
                        <span className="w-6 text-center font-bold tabular-nums">{line.quantity}</span>
                        <button
                          onClick={() => updateQty(line.id, 1)}
                          disabled={!!problem || line.quantity >= MAX_LINE_QUANTITY}
                          className="focus-ring grid h-8 w-8 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
                          aria-label={t('cart.increase')}
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </motion.li>
                    );
                  })}
                </AnimatePresence>
              </ul>
            )}
          </div>
          <div className="border-t border-border/60 p-4 space-y-3">
            {/* The customer's details scroll on their own, so a delivery's extra fields can
                never push Charge off a short screen. */}
            <div className="-mx-1 max-h-[42vh] space-y-3 overflow-y-auto px-1">
              <div className={channel !== 'dine_in' ? 'grid grid-cols-2 gap-2' : ''}>
                {/* Pickup and delivery are called out by name; dine-in is called out by
                    table, which the picker below already sets. Optional everywhere -- a queue
                    does not stop for a field nobody needs. */}
                {channel !== 'dine_in' && (
                  <label className="block min-w-0">
                    <span className="text-muted-foreground mb-1.5 block text-xs font-semibold uppercase tracking-wider">
                      {t('cart.customerName')}
                    </span>
                    <input
                      value={customerName}
                      onChange={(e) => setCustomerName(e.target.value.slice(0, 60))}
                      placeholder={t('cart.customerNamePlaceholder')}
                      className="focus-ring border-border bg-card h-10 w-full rounded-xl border px-3 text-base"
                    />
                  </label>
                )}
                {/* A number here finds THIS branch's customer, so a walk-in earns their own
                    points -- they used to land on the cashier's account. A delivery needs it
                    so the rider can call. */}
                <label className="block min-w-0">
                  <span className="text-muted-foreground mb-1.5 block truncate text-xs font-semibold uppercase tracking-wider">
                    {isDelivery ? t('cart.phoneDelivery') : t('cart.phonePoints')}
                  </span>
                  <input
                    value={phoneInput}
                    onChange={(e) => setPhoneInput(e.target.value.replace(/[^\d+\-() ]/g, '').slice(0, 24))}
                    onBlur={() => setPhoneTouched(true)}
                    placeholder={phoneCountry.placeholder}
                    inputMode="tel"
                    autoComplete="off"
                    aria-invalid={(phoneTouched && phoneInvalid) || undefined}
                    className={`focus-ring bg-card h-10 w-full rounded-xl border px-3 text-base ${
                      phoneTouched && (phoneInvalid || (isDelivery && phone.state === 'empty' && deliveryTouched))
                        ? 'border-danger'
                        : 'border-border'
                    }`}
                  />
                </label>
              </div>
              {phoneTouched && phoneInvalid && (
                <p className="text-danger -mt-2 text-xs">{t('cart.phoneInvalid')}</p>
              )}
              {isDelivery && (
                <div onBlur={() => setDeliveryTouched(true)}>
                  <CounterDeliveryFields
                    value={delivery}
                    onChange={setDelivery}
                    quote={deliveryQuote}
                    flatFee={deliveryFeeFlat}
                    branchCenter={branchCenter}
                    showErrors={deliveryTouched}
                  />
                </div>
              )}
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
                    <span>{t('cart.table')}</span>
                    {tables.length > 0 && (
                      <span className="font-normal normal-case tracking-normal">
                        {t('cart.tablesOnFloor', { count: tables.length })}
                      </span>
                    )}
                  </label>
                  {tables.length > 0 ? (
                    <>
                      <select
                        id="counter-table"
                        value={tableId ?? ''}
                        onChange={(e) => {
                          const picked = tables.find((tb) => tb.id === e.target.value) ?? null;
                          setTableId(picked?.id ?? null);
                          setTableNumber(picked?.number ?? '');
                        }}
                        className="focus-ring h-10 w-full rounded-xl border border-border bg-card px-3 text-base"
                      >
                        <option value="">{t('cart.noTable')}</option>
                        {tables.map((tb) => (
                          <option key={tb.id} value={tb.id}>
                            {tb.seated ? t('cart.tableSeated', { label: tb.label }) : tb.label}
                          </option>
                        ))}
                      </select>
                      {/* place-order joins the table's open sitting rather than starting a
                          rival one, so this round lands on the bill the diners' phones are
                          already adding to. Worth saying out loud before Charge is pressed. */}
                      {pickedTable?.seated && (
                        <p className="text-warning text-xs">
                          {t('cart.openBill', { label: pickedTable.label })}
                        </p>
                      )}
                      {pickedTable && !pickedTable.seated && (
                        <p className="text-muted-foreground text-xs">
                          {t('cart.seatsTable', { label: pickedTable.label })}
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
                      placeholder={t('cart.tableNumberPlaceholder')}
                      inputMode="numeric"
                      className="focus-ring h-10 w-full rounded-xl border border-border bg-card px-3 text-base"
                    />
                  )}
                </div>
              )}
              <div className="flex items-center gap-2">
                <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
                  {t('cart.discount')}
                  <input
                    inputMode="numeric"
                    value={discountInput}
                    onChange={(e) => setDiscountInput(digitsOnly(e.target.value).slice(0, 3))}
                    onBlur={() => setDiscountInput(discountInput === '' ? '' : String(discountPercent))}
                    placeholder="0"
                    aria-label={t('cart.discountAria')}
                    className="focus-ring h-9 w-16 rounded-lg border border-border bg-card px-2 text-base"
                  />
                </label>
                <label className="flex flex-1 items-center gap-2 text-xs text-muted-foreground">
                  {t('cart.split')}
                  <input
                    inputMode="numeric"
                    value={splitInput}
                    onChange={(e) => setSplitInput(digitsOnly(e.target.value).slice(0, 2))}
                    onBlur={() => setSplitInput(splitInput === '' ? '' : String(splitN))}
                    placeholder="1"
                    aria-label={t('cart.splitAria')}
                    className="focus-ring h-9 w-16 rounded-lg border border-border bg-card px-2 text-base"
                  />
                </label>
              </div>
            </div>
            {/* Every line the server will charge, itemised. The screen showed one bare
                number that left out tax and the card fee, so the cashier could not see
                what the customer was actually being asked for. */}
            <dl className="space-y-1 text-sm">
              <TotalRow label={t('totals.subtotal')} value={formatCurrency(cashQuote.subtotal)} />
              {cashQuote.discount > 0 && (
                <TotalRow
                  label={t('totals.discount', { percent: discountPercent })}
                  value={`−${formatCurrency(cashQuote.discount)}`}
                />
              )}
              {isDelivery && (
                <TotalRow label={t('totals.delivery')} value={formatCurrency(cashQuote.deliveryFee)} />
              )}
              {cashQuote.tax > 0 && (
                <TotalRow label={t('totals.tax')} value={formatCurrency(cashQuote.tax)} />
              )}
            </dl>
            <div className="flex items-baseline justify-between">
              <span className="text-sm font-medium text-muted-foreground">{t('totals.total')}</span>
              <span className="font-display text-3xl font-bold text-primary">
                {formatCurrency(total)}
              </span>
            </div>
            {canUseCard && cardQuote.serviceFee > 0 && (
              <p className="text-right text-xs text-muted-foreground">
                {t('totals.cardFee', {
                  percent: serviceFeePercent,
                  total: formatCurrency(cardQuote.total),
                })}
              </p>
            )}
            {splitN > 1 && (
              // Spelled out per tier when the total will not divide evenly: the cashier is
              // reading these numbers out to people who are about to hand them over, and
              // "$1.21 each" for a bill that needs two of them at $1.20 does not add up in
              // front of the table.
              <p className="text-right text-xs text-muted-foreground">
                {split.even
                  ? t('totals.splitEven', {
                      amount: formatCurrency(split.tiers[0]?.amount ?? 0),
                      ways: splitN,
                    })
                  : t('totals.splitUneven', {
                      parts: split.tiers
                        .map((tier) => `${tier.people} × ${formatCurrency(tier.amount)}`)
                        .join('  +  '),
                      ways: splitN,
                    })}
              </p>
            )}
            {unsettled.length > 0 && (
              <div className="-mx-1 max-h-[30vh] space-y-2 overflow-y-auto px-1">
                {unsettled.map((u) => (
                  <div
                    key={u.orderId}
                    role="alert"
                    className="space-y-2 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger"
                  >
                    <p>{t('pay.transferNotSettled', { number: u.orderNumber })}</p>
                    {u.error && (
                      <p className="text-xs">
                        {t(`settle.${u.error.key}`)}
                        {u.error.code && (
                          <span className="text-muted-foreground ml-1 font-mono text-[11px]">
                            ({u.error.code})
                          </span>
                        )}
                      </p>
                    )}
                    <div className="flex gap-2">
                      {/* Asking again cannot change a permanent answer (a cancelled order, no
                          payment to record), so only the ones that can succeed offer it. */}
                      {!u.error?.permanent && (
                        <Button
                          size="sm"
                          variant="outline"
                          loading={retryingId === u.orderId}
                          disabled={retryingId !== null && retryingId !== u.orderId}
                          onClick={() => void retrySettle(u)}
                        >
                          {t('pay.retrySettle')}
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" onClick={() => dismissUnsettled(u.orderId)}>
                        {t('pay.dismiss')}
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {payError && !payOpen && <ErrorNote error={payError} />}
            {customerFiled && (
              <div
                role="status"
                className={`flex items-start justify-between gap-2 rounded-xl px-3 py-2 text-xs ${
                  customerFiled.matched ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
                }`}
              >
                <p>
                  {customerFiled.matched
                    ? t('pay.customerMatched', { number: customerFiled.number })
                    : t('pay.customerWalkIn', { number: customerFiled.number })}
                </p>
                <button
                  type="button"
                  onClick={() => setCustomerFiled(null)}
                  aria-label={t('pay.dismiss')}
                  className="focus-ring shrink-0 rounded"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )}
            {chargeHint && <p className="text-muted-foreground text-xs">{chargeHint}</p>}
            <Button
              variant="gradient"
              size="xl"
              fullWidth
              disabled={chargeBlocked}
              onClick={() => {
                setPayError(null);
                setPayOpen(true);
                // Hours can end between polls; handlePay refuses if this comes back closed.
                if (isDelivery) void deliveryHours.recheck();
              }}
            >
              {t('totals.charge', { amount: formatCurrency(total) })}
            </Button>
          </div>
        </aside>
      </div>

      <CounterItemSheet
        item={pricedConfiguring?.item ?? null}
        listPrice={pricedConfiguring?.listPrice ?? null}
        priceLabel={pricedConfiguring?.label ?? null}
        onClose={() => setConfiguring(null)}
        onAdd={addConfigured}
      />

      <CounterComboSheet
        combo={liveConfiguringCombo}
        dishImages={liveConfiguringCombo ? comboDishImages(liveConfiguringCombo, itemImageById) : []}
        available={liveConfiguringCombo ? comboAvailable(liveConfiguringCombo) : true}
        onClose={() => setConfiguringCombo(null)}
        onAdd={addCombo}
      />

      {/* Payment sheet */}
      <Sheet
        open={payOpen}
        onClose={closePay}
        title={
          payStep === 'cash' ? t('pay.cashTitle') : payStep === 'qr' ? t('pay.qrTitle') : t('pay.title')
        }
        side="bottom"
      >
        <div className="space-y-3 p-5">
          {/* The QR step shows its own amount, beside the code the customer is scanning. */}
          {payStep !== 'qr' && (
            <p className="text-center font-display text-4xl font-bold text-primary">
              {formatCurrency(total)}
            </p>
          )}
          {payError && <ErrorNote error={payError} />}

          {payStep === 'cash' ? (
            <CashPad
              total={cashQuote.total}
              value={tenderedInput}
              onChange={setTenderedInput}
              submitting={submitting}
              onSettle={(tendered) => void handlePay('cash', tendered)}
              onBack={() => {
                setPayStep('choose');
                setTenderedInput('');
              }}
            />
          ) : payStep === 'qr' && qrTransfer && offerQr ? (
            <QrPad
              qr={qrTransfer}
              amount={transferQuote.total}
              submitting={submitting}
              onReceived={() => void handlePay('transfer')}
              onBack={() => setPayStep('choose')}
            />
          ) : (
            /* Card is dropped, not disabled: place-order rejects it server-side
               without the card_payment entitlement, so a visible button would
               only produce a failed sale in front of a waiting customer. The QR button
               is dropped the same way when this branch has no QR of its own, and both are
               dropped for a sale discounted to nothing (see offerCard / offerQr).
               Each button carries its own total — the card fee makes them differ, and the
               cashier has to know which number to ask for before pressing anything. */
            <>
              <div
                className={`grid grid-cols-1 gap-2 ${
                  [offerCard, offerQr].filter(Boolean).length === 2
                    ? 'sm:grid-cols-3'
                    : offerCard || offerQr
                      ? 'sm:grid-cols-2'
                      : ''
                }`}
              >
                <Button
                  variant="outline"
                  size="xl"
                  fullWidth
                  disabled={submitting}
                  // Cash counts the money out first. Card has nothing to count.
                  onClick={() => setPayStep('cash')}
                  leftIcon={<Banknote className="h-5 w-5" />}
                >
                  {t('pay.cash', { amount: formatCurrency(cashQuote.total) })}
                </Button>
                {offerCard && (
                  <Button
                    variant="outline"
                    size="xl"
                    fullWidth
                    loading={submitting}
                    onClick={() => void handlePay('card')}
                    leftIcon={<CreditCard className="h-5 w-5" />}
                  >
                    {t('pay.card', { amount: formatCurrency(cardQuote.total) })}
                  </Button>
                )}
                {offerQr && (
                  <Button
                    variant="outline"
                    size="xl"
                    fullWidth
                    disabled={submitting}
                    // Nothing is placed yet: the QR goes up, the customer pays from their
                    // banking app, and only "Payment received" rings the order up.
                    onClick={() => setPayStep('qr')}
                    leftIcon={<QrCode className="h-5 w-5" />}
                  >
                    {t('pay.qr', { amount: formatCurrency(transferQuote.total) })}
                  </Button>
                )}
              </div>
              {!qrTransfer && canEditBranchSettings && (
                <p className="text-muted-foreground text-center text-xs">
                  {t.rich('pay.qrSetupHint', {
                    link: (chunks) => (
                      <a
                        href={`/b/${branchId}/branch`}
                        className="text-primary font-semibold underline underline-offset-2"
                      >
                        {chunks}
                      </a>
                    ),
                  })}
                </p>
              )}
            </>
          )}
        </div>
      </Sheet>

      {parkLabel !== null && (
        <div
          className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4"
          onClick={() => setParkLabel(null)}
        >
          <div
            className="bg-card w-full max-w-sm space-y-3 rounded-3xl p-6 shadow-warm"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-lg font-semibold">{t('park.title')}</h2>
            <p className="text-muted-foreground text-sm">{t('park.body')}</p>
            <input
              value={parkLabel}
              onChange={(e) => setParkLabel(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') confirmPark();
                if (e.key === 'Escape') setParkLabel(null);
              }}
              autoFocus
              placeholder={t('park.placeholder')}
              className="focus-ring border-border bg-background h-12 w-full rounded-xl border px-3 text-base"
            />
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setParkLabel(null)}>
                {t('park.cancel')}
              </Button>
              <Button variant="gradient" onClick={confirmPark}>
                {t('header.park')}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Change owed. Not a toast: it stays until the cashier says they have handed it
          over, because it is the last thing standing between the drawer and the customer. */}
      {changeOwed != null && changeOwed > 0 && (
        <div className="fixed inset-0 z-[60] grid place-items-center bg-black/50 p-4">
          <div className="bg-card w-full max-w-sm rounded-3xl p-6 text-center shadow-warm">
            <p className="text-muted-foreground text-sm font-medium uppercase tracking-wider">
              {t('pay.changeDue')}
            </p>
            <p className="font-display text-primary my-2 text-5xl font-bold tabular-nums">
              {formatCurrency(changeOwed)}
            </p>
            <Button variant="gradient" size="xl" fullWidth onClick={() => setChangeOwed(null)}>
              {t('pay.handedOver')}
            </Button>
          </div>
        </div>
      )}

      {/* Success toast */}
      <AnimatePresence>
        {success && (
          <motion.div
            initial={{ y: 100, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 100, opacity: 0 }}
            className="fixed inset-x-0 bottom-6 z-50 mx-auto w-fit rounded-2xl bg-success px-5 py-3 text-white shadow-warm"
          >
            <span className="font-semibold">✓ {t('pay.success', { number: success })}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A refusal or a problem after the sale, with the code under it when there is one. */
function ErrorNote({ error }: { error: PayErrorState }) {
  return (
    <div role="alert" className="rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
      <p>{error.message}</p>
      {error.detail && <p className="mt-1 text-xs">{error.detail}</p>}
      {error.code && (
        <p className="text-muted-foreground mt-1 font-mono text-[11px]">({error.code})</p>
      )}
    </div>
  );
}

/**
 * Counting out a cash sale.
 *
 * The till used to charge cash the instant the button was pressed, with no record of what
 * was handed over and no change figure anywhere -- the cashier did the subtraction in their
 * head, every time, in front of the customer. The quick buttons are the notes somebody
 * actually hands you for this total, so the common sale is still one tap.
 */
function CashPad({
  total,
  value,
  onChange,
  submitting,
  onSettle,
  onBack,
}: {
  total: number;
  value: string;
  onChange: (v: string) => void;
  submitting: boolean;
  onSettle: (tendered: number) => void;
  onBack: () => void;
}) {
  const t = useTranslations('counter');
  const typed = value.trim() === '' ? null : Number(value);
  const tendered = typed != null && Number.isFinite(typed) ? typed : null;
  const change = tendered == null ? null : changeDue(tendered, total);
  const short = change != null && change < 0;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-2">
        {quickTender(total).map((amount, i) => (
          <Button
            key={amount}
            variant="outline"
            size="lg"
            fullWidth
            disabled={submitting}
            onClick={() => onSettle(amount)}
          >
            {i === 0 ? t('pay.exact') : formatCurrency(amount)}
          </Button>
        ))}
      </div>

      <label className="block">
        <span className="text-muted-foreground mb-1.5 block text-sm font-medium">
          {t('pay.tenderedLabel')}
        </span>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value.replace(/[^0-9.]/g, ''))}
          inputMode="decimal"
          placeholder={total.toFixed(2)}
          aria-label={t('pay.tenderedAria')}
          className="focus-ring border-border bg-background h-14 w-full rounded-xl border px-4 text-center font-display text-2xl font-bold tabular-nums"
        />
      </label>

      {change != null && (
        <p
          className={`text-center text-lg font-semibold tabular-nums ${
            short ? 'text-danger' : 'text-foreground'
          }`}
        >
          {short
            ? t('pay.short', { amount: formatCurrency(Math.abs(change)) })
            : t('pay.change', { amount: formatCurrency(change) })}
        </p>
      )}

      <div className="flex gap-2">
        <Button variant="ghost" size="xl" onClick={onBack} disabled={submitting}>
          {t('pay.back')}
        </Button>
        <Button
          variant="gradient"
          size="xl"
          fullWidth
          loading={submitting}
          disabled={tendered == null || short}
          onClick={() => tendered != null && onSettle(tendered)}
        >
          {t('pay.complete')}
        </Button>
      </div>
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
