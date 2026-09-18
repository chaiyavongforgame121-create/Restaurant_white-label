'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Banknote, ChevronLeft, CreditCard, LocateFixed, Map as MapIcon, MapPin, QrCode, ShoppingBag, Tag } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import {
  computeSalesTax,
  computeServiceFee,
  computeTipAmount,
  DELIVERY_SETTING_DEFAULTS,
  formatCurrency,
  isUiLocale,
  kmToMi,
  parseDeliverySettings,
  parseTipConfig,
  tipPresetsForChannel,
  TIP_CONFIG_DEFAULTS,
  type TipConfig,
  type UiLocale,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getMyLoyalty,
  listCustomerAddresses,
  listLoyaltyRewards,
  loyaltyRewardDiscount,
  placeOrder,
  quoteDelivery,
  upsertCustomerAddress,
  type DeliveryQuote,
  type LoyaltyReward,
  type PlaceOrderInput,
  type SavedAddress,
} from '@favornoms/database/queries';
import {
  AddressAutofillInput,
  GeolocationError,
  getCurrentPosition,
  LocationPicker,
  reverseGeocode,
  type GeolocationFailure,
  type ResolvedAddress,
} from '@favornoms/maps';
import { Badge, Button, Card, IconButton, Sheet } from '@favornoms/ui';
import { resolveMyCustomerId } from '@/lib/customer';
import { buildScheduleDays, type ClosurePeriod, type OpeningWindow } from '@/lib/schedule-slots';
import { pickerLabels } from '@/lib/picker-labels';
import { linesUsing, useCart, useCartHydrated } from '@/store/cart';
import { orderErrorKey, placeOrderBody, refusedCartPart } from './order-errors';
import { useAuth } from '@/components/auth/use-auth';
import { LeaveTableButton, useTablePin } from '../../_components/table-pin';

type PaymentMethod = 'card' | 'cash' | 'transfer';
type PaymentMode = 'asap' | 'scheduled';
type PaymentMatrix = Record<PaymentMode, Record<PaymentMethod, boolean>>;

// branches.settings.payment_methods — absent key/subkey means ENABLED (legacy
// branches accept everything). place-order enforces the same matrix server-side.
//
// `canUseCard` is the card_payment entitlement. It is ANDed in rather than
// checked at the render sites so that every downstream consumer — the choice
// tiles, the enabled-method fallback, the "no payment method" empty state —
// sees one consistent matrix. place-order enforces the same thing server-side.
function parsePaymentMatrix(
  settings: Record<string, unknown>,
  canUseCard: boolean,
): PaymentMatrix {
  const raw = settings.payment_methods as
    | Partial<Record<PaymentMode, Partial<Record<PaymentMethod, unknown>>>>
    | undefined;
  const read = (mode: PaymentMode, method: PaymentMethod) => {
    if (method === 'card' && !canUseCard) return false;
    const v = raw?.[mode]?.[method];
    return typeof v === 'boolean' ? v : true;
  };
  // Transfer is opt-in and additionally requires a saved QR image, mirroring
  // place-order's `transfer_not_configured` guard — otherwise the diner reaches a
  // payment step with nothing to scan.
  const qrReady = !!(settings.qr_transfer as { image_url?: string } | undefined)?.image_url;
  const readTransfer = (mode: PaymentMode) => qrReady && raw?.[mode]?.transfer === true;
  return {
    asap: { cash: read('asap', 'cash'), card: read('asap', 'card'), transfer: readTransfer('asap') },
    scheduled: {
      cash: read('scheduled', 'cash'),
      card: read('scheduled', 'card'),
      transfer: readTransfer('scheduled'),
    },
  };
}

/**
 * Whether this storefront can actually take a card.
 *
 * It cannot, and no environment variable changes that. Nothing in apps/web mounts Stripe
 * Elements, and `stripe-create-payment-intent` creates the intent with
 * `automatic_payment_methods`, which can only be confirmed through a PaymentElement and
 * `stripe.confirmPayment({ elements, confirmParams: { return_url } })`. The order page's
 * card box therefore had no card to attach and no way to attach one — every card order
 * ever placed here is still sitting at `payments.status = 'pending'`.
 *
 * Offering the tile anyway sold the diner an order they could not pay for and then
 * stranded them on a tracking screen with a dead button, so the tile comes down and the
 * reason is said out loud. Flip this to `!!process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
 * in the same change that mounts Elements — never before it.
 */
const CARD_CHECKOUT_AVAILABLE: boolean = false;

/**
 * The merchant's matrix, masked down to what the app can genuinely collect.
 *
 * Kept separate from parsePaymentMatrix so the checkout can still tell the difference
 * between "this restaurant does not take card" (say nothing) and "this restaurant takes
 * card but we cannot process it here" (say so).
 */
function withCollectableCard(matrix: PaymentMatrix): PaymentMatrix {
  if (CARD_CHECKOUT_AVAILABLE) return matrix;
  return {
    asap: { ...matrix.asap, card: false },
    scheduled: { ...matrix.scheduled, card: false },
  };
}

// The `customer-auth` edge function mints phone-only diners as synthetic
// `c{digits}@customer.favornoms.local` users with `email_confirm: true`, so they
// carry a provider-'email' identity that proves nothing. Excluding this domain is
// what keeps the loyalty gate meaningful. place-order excludes the same domain —
// keep both in sync with EMAIL_DOMAIN in supabase/functions/customer-auth/index.ts.
const SYNTHETIC_CUSTOMER_EMAIL_SUFFIX = '@customer.favornoms.local';

// `datetime-local` reads its value/min/max as LOCAL wall-clock time, so they must
// never be built from toISOString() — that is UTC, and in every US timezone it
// reads hours ahead of the diner's actual clock.
function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// place-order's r2, character for character. Every money expression below is a
// mirror of the server's, because the diner agrees to the number on this screen
// and the server charges its own — the two have to land on the same cent.
const r2 = (n: number) => Math.round(n * 100) / 100;

type DropoffPref = 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other';

// The values are what place-order stores as delivery_address.dropoff_pref; the words shown for
// them are checkout.dropoff.options.<value>.
const DROPOFF_OPTIONS: DropoffPref[] = ['leave_at_door', 'hand_to_me', 'at_desk', 'other'];

interface Props {
  branchId: string;
  base: string;
  /** `delivery` entitlement — default false so a missing prop cannot sell it. */
  canDeliver?: boolean;
  /** `card_payment` entitlement — same. */
  canUseCard?: boolean;
  /**
   * branches.sales_tax_rate as a decimal (0.0701 = 7.01%). Defaults to 0 like
   * place-order's `Number(branch.sales_tax_rate ?? 0)` — a branch that charges
   * no tax and a missing prop are the same number, so neither can invent one.
   */
  salesTaxRate?: number;
  /** branches.settings.service_fee_percent, whole percent. Server default is 0. */
  serviceFeePercent?: number;
  /**
   * The branch's own scheduling policy, straight from storefront_status.
   *
   * The picker used to be a bare datetime-local with hardcoded now+15m / now+14d bounds,
   * so a diner could choose a time the branch is shut, fill in the whole form, and only
   * discover it at submit. These are the same hours is_branch_open() enforces, so the
   * offered slots and the server's answer cannot disagree.
   */
  scheduling?: {
    enabled: boolean;
    timezone: string;
    openingHours: OpeningWindow[];
    minLeadMinutes: number;
    maxDays: number;
    slotMinutes: number;
    /** Delivery hours when the merchant restricted them, null when not. Every storefront
     *  delivery is booked now, so its slots must also sit inside these or the
     *  orders_enforce_delivery_hours trigger refuses the order at submit. */
    deliveryWindows?: OpeningWindow[] | null;
  };
  /**
   * is_branch_open() when the page was rendered. Pickup is always prepared now, so a closed
   * branch cannot take one: checkout says so up front instead of letting the diner fill in the
   * whole form for a 409. Defaults true — place-order still refuses, and a missing prop must
   * never block ordering.
   */
  pickupOpenNow?: boolean;
  /** The kitchen paused orders. Nothing can be ordered, now or booked (resolveScheduleDelivery). */
  ordersPaused?: boolean;
}

export function CheckoutView({
  branchId,
  base,
  canDeliver = false,
  canUseCard = false,
  salesTaxRate = 0,
  serviceFeePercent = 0,
  scheduling,
  pickupOpenNow = true,
  ordersPaused = false,
}: Props) {
  const t = useTranslations();
  const rawLocale = useLocale();
  const locale: UiLocale = isUiLocale(rawLocale) ? rawLocale : 'en';
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const subtotal = useCart((s) => s.subtotal());
  const lines = useCart((s) => s.lines);
  const notes = useCart((s) => s.notes);
  const removeLine = useCart((s) => s.remove);
  // This branch's cart only (CartProvider), so clearing it after an order leaves every other
  // branch's cart on this device exactly as it was.
  const clear = useCart((s) => s.clear);
  // null until the diner picks an order type. OrderTypeGate (mounted by the page)
  // covers checkout until they do, so the null window is never interactive.
  const channel = useCart((s) => s.channel);
  const setChannel = useCart((s) => s.setChannel);
  // Open right now, for Pickup. The page reads it once on the server, so a branch that opens while
  // the diner is on this page would keep Pickup disabled until a reload; while closed it is asked
  // again every minute. Not while paused — no amount of waiting on the clock changes that.
  const [openNow, setOpenNow] = React.useState(pickupOpenNow);
  React.useEffect(() => {
    if (openNow || ordersPaused) return;
    const supabase = getBrowserClient();
    const timer = setInterval(() => {
      void supabase.rpc('is_branch_open', { p_branch_id: branchId }).then(({ data }) => {
        if (data === true) setOpenNow(true);
      });
    }, 60_000);
    return () => clearInterval(timer);
  }, [openNow, ordersPaused, branchId]);
  // Only ever set for THIS branch — the provider drops a pin scanned anywhere else.
  const { table: pinnedTable, bill: tableBill } = useTablePin();

  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [savedAddresses, setSavedAddresses] = React.useState<SavedAddress[]>([]);
  const [selectedAddressId, setSelectedAddressId] = React.useState<string | 'new' | null>(null);
  const [addressCoords, setAddressCoords] = React.useState<{ lat: number; lng: number } | null>(null);
  const [addressMeta, setAddressMeta] = React.useState<{
    line2?: string;
    city?: string;
    state?: string;
    postal_code?: string;
  } | null>(null);
  const [customerId, setCustomerId] = React.useState<string | null>(null);
  const [quote, setQuote] = React.useState<DeliveryQuote | null>(null);
  const [quoting, setQuoting] = React.useState(false);
  // branches.settings.delivery_fee, the fee charged when an address has no coordinates.
  // place-order reads the same key (`Number(settings.delivery_fee ?? 3.99)`); hardcoding
  // 3.99 here showed the diner one number and charged another on any legacy branch row
  // that carries the key.
  const [legacyFlatFee, setLegacyFlatFee] = React.useState<number>(
    DELIVERY_SETTING_DEFAULTS.legacyFlatFee,
  );
  const [addressNotes, setAddressNotes] = React.useState('');
  const [dropoffPref, setDropoffPref] = React.useState<DropoffPref | null>(null);
  const [dropoffOther, setDropoffOther] = React.useState('');
  const [gateCode, setGateCode] = React.useState('');
  const [room, setRoom] = React.useState('');
  // The exact line1 Mapbox last resolved — guards against the autofill's own
  // input event clearing the coordinates immediately after onResolved sets them.
  const resolvedAddressRef = React.useRef<string | null>(null);
  const [method, setMethod] = React.useState<PaymentMethod>('card');
  const [qrTransfer, setQrTransfer] = React.useState<{
    image_url?: string;
    account_name?: string;
    instructions?: string;
  } | null>(null);
  // Seeded from the entitlement, not from PAYMENT_MATRIX_DEFAULTS: the branch
  // settings arrive a tick later, and for that tick an unentitled branch would
  // otherwise offer Card.
  const [merchantPaymentMatrix, setMerchantPaymentMatrix] = React.useState<PaymentMatrix>(() =>
    parsePaymentMatrix({}, canUseCard),
  );
  // Everything downstream — the tiles, the enabled-method fallback, the empty state and
  // the service fee — reads the masked matrix, so no part of the checkout can offer a
  // method another part knows cannot be collected.
  const paymentMatrix = React.useMemo(
    () => withCollectableCard(merchantPaymentMatrix),
    [merchantPaymentMatrix],
  );
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // Map picker + geolocation
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [branchCenter, setBranchCenter] = React.useState<{ lat: number; lng: number } | null>(null);
  const [locatingQuick, setLocatingQuick] = React.useState(false);
  const [geoError, setGeoError] = React.useState<string | null>(null);
  // Per-field validation messages (cleared as the user edits the field).
  const [fieldErrors, setFieldErrors] = React.useState<Record<string, string>>({});
  const nameRef = React.useRef<HTMLInputElement | null>(null);
  const phoneRef = React.useRef<HTMLInputElement | null>(null);
  const emailRef = React.useRef<HTMLInputElement | null>(null);
  const addressSectionRef = React.useRef<HTMLDivElement | null>(null);
  const dropoffSectionRef = React.useRef<HTMLDivElement | null>(null);
  const scheduleSectionRef = React.useRef<HTMLDivElement | null>(null);
  const clearFieldError = (key: string) =>
    setFieldErrors((cur) => {
      if (!cur[key]) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });
  const [pointsBalance, setPointsBalance] = React.useState(0);
  // The merchant's published reward catalog. Points are no longer spendable as
  // free-form dollars-off — the diner picks one of these or spends nothing.
  const [rewards, setRewards] = React.useState<LoyaltyReward[]>([]);
  const [rewardId, setRewardId] = React.useState<string | null>(null);
  // Redeeming points needs a proven identity — a linked Google account OR a real
  // (non-synthetic) confirmed email. Phone sign-in is OTP-less, so a phone number
  // alone is not proof of who you are. place-order is the real gate — this flag
  // only pre-empts the 403, so it FAILS OPEN: we start at true and only flip it
  // when the identity call actually says otherwise.
  const [identityVerified, setIdentityVerified] = React.useState(true);
  const [tipPercent, setTipPercent] = React.useState<number>(0);
  const [customTip, setCustomTip] = React.useState('');
  // Custom is a chip like the percentages, not an always-on field — the USD input
  // only exists once it is chosen.
  const [tipCustom, setTipCustom] = React.useState(false);
  const [tipConfig, setTipConfig] = React.useState<TipConfig>(TIP_CONFIG_DEFAULTS);
  const [promoCode, setPromoCode] = React.useState('');
  // Derived, never stored. Customers order one of two ways — Pickup (prepared now) or Schedule
  // Delivery (a booked time) — so the timing IS the order type. As separate state it started at
  // 'asap' on every mount while the channel persisted in the cart, so a diner who picked
  // Schedule Delivery on the menu arrived here holding an ASAP delivery.
  const scheduleMode: 'asap' | 'later' = channel === 'delivery' ? 'later' : 'asap';
  // Holds a UTC ISO instant now, not a datetime-local string: the slots are generated in
  // the BRANCH's zone, so the diner's own clock never enters the calculation.
  const [scheduledFor, setScheduledFor] = React.useState<string>('');
  const [scheduleDate, setScheduleDate] = React.useState<string>('');
  // The clock the slot list is measured from. Captured when the page opens, again when the diner
  // chooses Schedule Delivery, and again if the chosen slot has gone stale by submit — never on
  // a timer, so the list cannot shift under the diner while they fill in the form.
  const [slotClock, setSlotClock] = React.useState(() => new Date());
  // Opening hours are only half of what decides a bookable time. The merchant can also
  // narrow bookings per weekday (branch_schedule_hours) and close the shop for a holiday
  // (branch_closures); is_branch_open() and is_schedule_window_open() both refuse a slot
  // outside those, so offering one means a diner fills in the whole form for a 409.
  //
  // Read here rather than through the `scheduling` prop: that comes from storefront_status,
  // which is fetched on the server page, and this policy is one anon RPC the picker can ask
  // for itself. Null means "not answered yet"; a branch that never armed windows comes back
  // with `windows: null`, which is today's behaviour exactly.
  const [bookingPolicy, setBookingPolicy] = React.useState<{
    windows: OpeningWindow[] | null;
    closures: ClosurePeriod[];
  } | null>(null);

  React.useEffect(() => {
    if (!scheduling?.enabled) return;
    let cancelled = false;
    void (async () => {
      // packages/database/src/types.ts is regenerated centrally and does not know this RPC
      // yet. A deployment that predates it answers with an error and no data, which lands
      // on the same fail-open defaults below — opening hours alone, as before.
      const { data } = await (
        getBrowserClient() as unknown as {
          rpc: (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown }>;
        }
      ).rpc('branch_schedule_policy', { p_branch_id: branchId });
      if (cancelled) return;
      const d = (data ?? {}) as Record<string, unknown>;
      setBookingPolicy({
        // null, not [] — an empty array means "nothing bookable all week", and defaulting
        // to it would silently remove scheduling from every branch on the platform.
        windows:
          d.schedule_hours_enabled === true && Array.isArray(d.schedule_windows)
            ? (d.schedule_windows as OpeningWindow[])
            : null,
        closures: Array.isArray(d.closures) ? (d.closures as ClosurePeriod[]) : [],
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, scheduling?.enabled]);

  // Plain strings, so the slot list is rebuilt when the language changes and not on every render.
  const todayLabel = t('checkout.schedule.today');
  const tomorrowLabel = t('checkout.schedule.tomorrow');
  const scheduleDays = React.useMemo(() => {
    if (!scheduling?.enabled) return [];
    // Nothing until the policy lands. Showing the un-narrowed list first and pulling times
    // back out from under the diner a moment later is worse than a brief wait.
    if (!bookingPolicy) return [];
    return buildScheduleDays({
      timezone: scheduling.timezone,
      openingHours: scheduling.openingHours,
      scheduleWindows: bookingPolicy.windows,
      closures: bookingPolicy.closures,
      deliveryWindows: scheduling.deliveryWindows ?? null,
      minLeadMinutes: scheduling.minLeadMinutes,
      maxDays: scheduling.maxDays,
      slotMinutes: scheduling.slotMinutes,
      now: slotClock,
      locale,
      dayLabels: { today: todayLabel, tomorrow: tomorrowLabel },
    });
  }, [scheduling, bookingPolicy, slotClock, locale, todayLabel, tomorrowLabel]);

  const selectedDay = scheduleDays.find((d) => d.date === scheduleDate) ?? scheduleDays[0];

  // Preselect the first open slot so "Schedule for later" is never a dead end the diner has
  // to fight, and re-point it if the policy changes underneath.
  React.useEffect(() => {
    if (scheduleDays.length === 0) {
      if (scheduledFor) setScheduledFor('');
      return;
    }
    const stillValid = scheduleDays.some((d) => d.slots.some((sl) => sl.iso === scheduledFor));
    const first = scheduleDays[0];
    if (!stillValid && first) {
      setScheduleDate(first.date);
      setScheduledFor(first.slots[0]?.iso ?? '');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduleDays]);

  // Errors hold the server's CODE (validate_promo_code's `error`, check_gift_card's `reason`),
  // not a sentence: the words are chosen at render, in the diner's language.
  const [promoState, setPromoState] = React.useState<
    | { status: 'idle' }
    | { status: 'validating' }
    | { status: 'applied'; amount_off: number; free_delivery: boolean; promo_id: string }
    | { status: 'error'; code: string; minSubtotal?: number }
  >({ status: 'idle' });
  const [giftCardCode, setGiftCardCode] = React.useState('');
  const [giftCardState, setGiftCardState] = React.useState<
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'valid'; balance: number }
    | { status: 'error'; code: string }
  >({ status: 'idle' });

  // Distance-based quote when the address has coordinates (server-authoritative —
  // place-order runs the same quote_delivery formula); legacy flat fee otherwise.
  const outOfRange =
    channel === 'delivery' && quote != null && !quote.deliverable && quote.reason === 'out_of_range';
  // The branch has no delivery add-on. place-order answers 403 for this, so quoting ANY
  // fee would be selling something that cannot be bought — the flat-fee fallback below is
  // for a missing pin, not for a branch that does not deliver.
  const deliveryNotSold =
    channel === 'delivery' &&
    quote != null &&
    !quote.deliverable &&
    quote.reason === 'delivery_not_entitled';
  const deliveryFeeBase =
    channel !== 'delivery' || deliveryNotSold ? 0 : quote?.deliverable ? quote.fee : legacyFlatFee;
  const promoFreeDelivery = promoState.status === 'applied' && promoState.free_delivery;
  // Coordinates are required only while ENTERING a new address (the autofill is on screen and
  // actionable). A previously-saved address that happens to lack coords must not trap checkout —
  // it falls back to the flat delivery fee.
  const enteringNewAddress = savedAddresses.length === 0 || selectedAddressId === 'new';
  // Dine-in is ASAP only and has no payment step — the diner settles at the
  // restaurant. Both cards are hidden below, so every consumer reads through
  // these forced values instead of the raw state: a leftover `scheduleMode ===
  // 'later'` would send a real scheduled_for (the time input is always
  // pre-populated), re-gate the order against the *scheduled* payment matrix and
  // could set held=true — which hides the order from the kitchen.
  const isDineIn = channel === 'dine_in';
  // A scanned table is an id the storefront was handed by the server, not a number the
  // diner typed — so it needs no field, no validation and no guessing at the other end.
  const atTable = isDineIn && pinnedTable !== null;
  const effectiveScheduleMode: 'asap' | 'later' = isDineIn ? 'asap' : scheduleMode;
  const paymentModeKey: PaymentMode = effectiveScheduleMode === 'later' ? 'scheduled' : 'asap';
  // What place-order will actually be told. Dine-in has no payment step, so it is sent
  // as 'cash' — and everything priced off the method has to read this, not `method`.
  const effectivePaymentMethod: PaymentMethod = isDineIn ? 'cash' : method;
  const enabledMethods = (['card', 'cash', 'transfer'] as const).filter(
    (m) => paymentMatrix[paymentModeKey][m],
  );
  // The restaurant does sell card at this mode; this storefront just cannot take one.
  // Worth saying rather than silently dropping a method the diner may have been told to
  // expect — and worth saying HERE, before they commit, instead of on the order page
  // afterwards where the only card button could never have worked.
  const cardWithheld =
    !isDineIn && merchantPaymentMatrix[paymentModeKey].card && !paymentMatrix[paymentModeKey].card;
  const asapPayable =
    paymentMatrix.asap.cash || paymentMatrix.asap.card || paymentMatrix.asap.transfer;
  const scheduledPayable =
    paymentMatrix.scheduled.cash || paymentMatrix.scheduled.card || paymentMatrix.scheduled.transfer;
  // What each way to order needs. Schedule Delivery: the add-on and advance orders (canDeliver,
  // from canScheduleDelivery) plus a payment method for booked orders; whether any slot is left
  // is known once the booking policy has loaded. Pickup: a payment method for orders placed now,
  // and the branch open at this moment.
  const deliveryBookable = canDeliver && !!scheduling?.enabled && scheduledPayable;
  const deliverySlotsKnown = !scheduling?.enabled || bookingPolicy !== null;
  const deliveryHasSlots = scheduleDays.length > 0;
  const pickupAvailable = asapPayable && openNow;
  // "You can still schedule a delivery" is only said when a slot is actually there to book.
  const deliveryOfferable = deliveryBookable && (!deliverySlotsKnown || deliveryHasSlots);
  const chooseOrderType = (next: 'pickup' | 'delivery') => {
    if (next === channel) return;
    setChannel(next);
    // Errors belong to the fields of the order type being left; carrying them over would put a
    // red address box on a Pickup, or bring an old one back on the way to delivery.
    setFieldErrors({});
    setError(null);
    // Slots are measured from the moment delivery is chosen, not from when the page opened.
    if (next === 'delivery') setSlotClock(new Date());
  };
  // Card-only, and derived from the SELECTED tile so the summary row and the
  // "Place order" button re-price the instant the diner switches to cash or QR
  // transfer. Mirrors the same rule in place-order.
  const serviceFee = computeServiceFee(subtotal, serviceFeePercent, effectivePaymentMethod);
  // Why a reward may not be redeemable right now. Returning the reason (not just
  // a boolean) lets each card say what to DO about it instead of being mutely
  // greyed out. `free_item` needs its item actually in the cart — the reward pays
  // for one you ordered, it does not add one.
  const rewardBlocker = React.useCallback(
    (r: LoyaltyReward): string | null => {
      if (r.points_cost > pointsBalance)
        return t('checkout.rewards.needsMore', { count: r.points_cost - pointsBalance });
      if (subtotal < Number(r.min_subtotal))
        return t('checkout.rewards.spendToUnlock', { amount: formatCurrency(Number(r.min_subtotal)) });
      // Combo lines reuse menuItemId to carry the combo id, so they must not
      // satisfy a free-item reward for a menu item that merely shares the slot.
      if (
        r.kind === 'free_item' &&
        !lines.some((l) => !l.comboId && l.menuItemId === r.menu_item_id)
      )
        // The item name is the merchant's, shown exactly as they typed it.
        return r.menu_item_name
          ? t('checkout.rewards.addItem', { item: r.menu_item_name })
          : t('checkout.rewards.addTheItem');
      if (r.kind === 'free_delivery' && (channel !== 'delivery' || deliveryFeeBase <= 0))
        return t('checkout.rewards.deliveryOnly');
      return null;
    },
    [pointsBalance, subtotal, lines, channel, deliveryFeeBase, t],
  );
  const selectedReward = rewards.find((r) => r.id === rewardId) ?? null;
  // Zero without a verified identity, and zero the moment the cart changes out
  // from under a selection, so the summary total matches what the server will
  // actually charge instead of promising a discount place-order would reject.
  const appliedReward =
    selectedReward && identityVerified && !rewardBlocker(selectedReward) ? selectedReward : null;
  // Mirrors the switch in place-order. The server is authoritative; this only
  // keeps the on-screen total honest.
  const loyaltyDollarsOff = appliedReward ? loyaltyRewardDiscount(appliedReward, subtotal) : 0;
  // Declared here rather than beside deliveryFeeBase because a free-delivery
  // REWARD can zero the fee too, and that depends on the reward being applicable
  // — which in turn is measured against deliveryFeeBase, never against this.
  const deliveryFee =
    promoFreeDelivery || appliedReward?.kind === 'free_delivery' ? 0 : deliveryFeeBase;
  const tipAmount = computeTipAmount(subtotal, tipPercent, customTip);
  // Product-fixed 18 / 20 / 25 — parseTipConfig ignores any presets on the row.
  const tipPresets = tipPresetsForChannel(tipConfig, channel ?? 'pickup');
  const noTipSelected = !tipCustom && !customTip && tipPercent === 0;
  const tipWorkerPct = (tipConfig[channel ?? 'pickup'] ?? tipConfig.dine_in).workerPct;
  const promoDiscount = promoState.status === 'applied' ? promoState.amount_off : 0;
  // The discounted food line. Tax is charged on it, and the gift card can only
  // ever cover it — fees, tip and delivery are never bought with card balance.
  // Discounts can exceed the food, hence the clamp before anything reads it.
  const taxableBase = Math.max(0, subtotal - loyaltyDollarsOff - promoDiscount);
  const taxAmount = computeSalesTax(taxableBase, salesTaxRate);
  const giftCardCredit =
    giftCardState.status === 'valid' ? Math.min(giftCardState.balance, taxableBase) : 0;
  const total = r2(
    Math.max(0, taxableBase + deliveryFee + serviceFee + tipAmount + taxAmount - giftCardCredit),
  );

  const checkGiftCard = async () => {
    if (!giftCardCode.trim()) return;
    setGiftCardState({ status: 'checking' });
    const supabase = getBrowserClient();
    // A gift card is good only at the branch that issued it, so the check names this branch.
    // The cast covers a generated type that still lists the one-argument form; that form is
    // also the fallback while a database has not taken the branch parameter yet (PGRST202:
    // no function with these arguments), so the field never breaks during a rollout.
    const code = giftCardCode.trim();
    let { data, error } = await supabase.rpc('check_gift_card', {
      p_code: code,
      p_branch_id: branchId,
    } as unknown as { p_code: string });
    if (error?.code === 'PGRST202') {
      ({ data, error } = await supabase.rpc('check_gift_card', { p_code: code }));
    }
    if (error) {
      // The raw text is for us, not the diner.
      console.error('check_gift_card_failed', error.message);
      setGiftCardState({ status: 'error', code: 'request_failed' });
      return;
    }
    const r = data as { valid?: boolean; reason?: string; balance?: number };
    if (!r?.valid) {
      setGiftCardState({ status: 'error', code: r?.reason ?? 'invalid' });
      return;
    }
    setGiftCardState({ status: 'valid', balance: Number(r.balance ?? 0) });
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void getMyLoyalty(supabase, branchId).then((row) => {
      if (row) setPointsBalance(row.points_balance);
    });
    void listLoyaltyRewards(supabase, branchId).then(setRewards);
    void (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      // Resolve identity exactly like account settings does. Querying `customers`
      // by user_id and taking the newest row could land on a DIFFERENT row, so a
      // name/phone saved in settings never showed up here.
      let cid: string;
      try {
        cid = await resolveMyCustomerId(branchId);
      } catch {
        // Prefill is a convenience — the diner can still type their details.
        return;
      }
      const { data: customer } = await supabase
        .from('customers')
        .select('id, full_name, phone, email')
        .eq('id', cid)
        .maybeSingle();
      setCustomerId(cid);
      if (customer?.full_name) setName(customer.full_name);
      if (customer?.phone) setPhone(customer.phone);
      if (customer?.email) setEmail(customer.email);
      const addrs = await listCustomerAddresses(supabase, cid);
      if (addrs.length > 0) {
        setSavedAddresses(addrs);
        const def = addrs.find((a) => a.is_default) ?? addrs[0];
        if (def) {
          setSelectedAddressId(def.id);
          setAddress([def.address_line1, def.address_line2].filter(Boolean).join(', '));
          setAddressCoords(def.lat != null && def.lng != null ? { lat: def.lat, lng: def.lng } : null);
        }
      }
    })();
  }, [branchId]);

  // Loyalty redemption needs a proven identity on the account. Read it once so the
  // redeem control can explain itself up front rather than letting the diner drag
  // the slider and meet a 403. Any failure leaves the flag at true — the server
  // still refuses, and a flaky identity call must not silently take someone's
  // points away from them.
  //
  // MUST mirror place-order's predicate exactly: a linked Google identity, OR a
  // confirmed email identity that is not one of customer-auth's synthetic
  // c{digits}@customer.favornoms.local addresses (every phone-only diner has one
  // of those, so `provider !== 'phone'` would wave the whole gate through).
  React.useEffect(() => {
    const supabase = getBrowserClient();
    void (async () => {
      try {
        const [{ data: idData, error: idErr }, { data: userData }] = await Promise.all([
          supabase.auth.getUserIdentities(),
          supabase.auth.getUser(),
        ]);
        if (idErr || !idData) return;
        const identities = idData.identities ?? [];
        if (identities.some((i) => i.provider === 'google')) {
          setIdentityVerified(true);
          return;
        }
        // getUserIdentities() carries no confirmation timestamp, so take it from the
        // user record (identity_data.email_verified as a fallback for odd shapes).
        const emailConfirmed = !!userData?.user?.email_confirmed_at;
        const realEmail = identities.some((i) => {
          if (i.provider !== 'email') return false;
          const raw = (i.identity_data?.email as unknown) ?? userData?.user?.email;
          const addr = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
          if (!addr || addr.endsWith(SYNTHETIC_CUSTOMER_EMAIL_SUFFIX)) return false;
          return emailConfirmed || i.identity_data?.email_verified === true;
        });
        setIdentityVerified(realEmail);
      } catch {
        // Leave the flag at true — the server is the real gate.
      }
    })();
  }, []);

  // The driver/house/staff split is configured per branch (jsonb tip_config);
  // the preset chips are product-fixed and parseTipConfig ignores any on the row.
  // place-order + the completion trigger record the authoritative split on the
  // server; this only drives the disclosure copy.
  React.useEffect(() => {
    const supabase = getBrowserClient();
    void supabase
      .from('branches')
      .select('settings')
      .eq('id', branchId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.settings) {
          const settings = data.settings as Record<string, unknown>;
          setTipConfig(parseTipConfig(settings));
          setLegacyFlatFee(parseDeliverySettings(settings).legacyFlatFee);
          setMerchantPaymentMatrix(parsePaymentMatrix(settings, canUseCard));
          setQrTransfer(
            (settings.qr_transfer as {
              image_url?: string;
              account_name?: string;
              instructions?: string;
            }) ?? null,
          );
        }
      });
  }, [branchId, canUseCard]);

  // Keep the selected payment method valid for the current order type. It never changes the
  // order type itself: when one has no payment methods at all, the order-type card says so and
  // submit stays disabled. It used to flip ASAP <-> scheduled here, which now would silently turn
  // a Pickup into a delivery or back — a different order from the one the diner chose.
  //
  // Dine-in opts out entirely: it has no payment step on screen.
  React.useEffect(() => {
    if (isDineIn) return;
    const modeKey: PaymentMode = scheduleMode === 'later' ? 'scheduled' : 'asap';
    const enabled = (['card', 'cash', 'transfer'] as const).filter((m) => paymentMatrix[modeKey][m]);
    const fallback = enabled[0];
    if (fallback && !enabled.includes(method)) setMethod(fallback);
  }, [scheduleMode, paymentMatrix, method, isDineIn]);

  // The restaurant's own coordinates make a sensible default centre for the map
  // picker when the customer hasn't entered an address yet.
  React.useEffect(() => {
    if (channel !== 'delivery') return;
    const supabase = getBrowserClient();
    void supabase
      .from('branches')
      .select('geo_lat, geo_lng')
      .eq('id', branchId)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.geo_lat != null && data?.geo_lng != null) {
          setBranchCenter({ lat: Number(data.geo_lat), lng: Number(data.geo_lng) });
        }
      });
  }, [branchId, channel]);

  // Shared by the map picker and the "use current location" button: drop a
  // resolved address into the same state the autofill feeds, and treat it as a
  // freshly-entered ("new") address so it's saved and quoted like any other.
  const applyResolvedAddress = React.useCallback((a: ResolvedAddress) => {
    const line1 = [a.line1, a.line2].filter(Boolean).join(', ');
    resolvedAddressRef.current = line1;
    setAddress(line1);
    setAddressCoords({ lat: a.lat, lng: a.lng });
    setAddressMeta({ line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code });
    setSelectedAddressId('new');
    setGeoError(null);
    clearFieldError('address');
  }, []);

  const geoFailureMessage = React.useCallback(
    (reason: GeolocationFailure): string => {
      switch (reason) {
        case 'insecure_context':
          return t('checkout.geo.insecure');
        case 'unsupported':
          return t('checkout.geo.unsupported');
        case 'denied':
          return t('checkout.geo.denied');
        case 'timeout':
          return t('checkout.geo.timeout');
        default:
          return t('checkout.geo.unavailable');
      }
    },
    [t],
  );

  // One-tap "use current location" on the checkout itself (the picker has its
  // own button too). Geolocate, reverse-geocode, then fill the address.
  const handleQuickCurrentLocation = async () => {
    setGeoError(null);
    setLocatingQuick(true);
    try {
      const pos = await getCurrentPosition();
      const resolved = await reverseGeocode(pos);
      // reverseGeocode only returns null when Mapbox is unconfigured; fall back to
      // a coordinate label so the address field is non-empty and the order isn't
      // blocked by the "address required" check.
      applyResolvedAddress(
        resolved ?? {
          line1: `${pos.lat.toFixed(5)}, ${pos.lng.toFixed(5)}`,
          lat: pos.lat,
          lng: pos.lng,
        },
      );
    } catch (e) {
      const reason: GeolocationFailure = e instanceof GeolocationError ? e.reason : 'unavailable';
      setGeoError(geoFailureMessage(reason));
    } finally {
      setLocatingQuick(false);
    }
  };

  // Live delivery quote whenever we know the dropoff coordinates.
  React.useEffect(() => {
    if (channel !== 'delivery' || !addressCoords) {
      setQuote(null);
      setQuoting(false);
      return;
    }
    let cancelled = false;
    setQuoting(true);
    const timer = setTimeout(() => {
      const supabase = getBrowserClient();
      void quoteDelivery(supabase, branchId, addressCoords.lat, addressCoords.lng).then((q) => {
        if (!cancelled) {
          setQuote(q);
          setQuoting(false);
        }
      });
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [channel, addressCoords, branchId]);

  // Wait for this branch's stored cart before showing an "empty" cart —
  // otherwise the page renders empty on first mount before localStorage loads.
  const hydrated = useCartHydrated();

  // Login is mandatory to check out — guest checkout was removed. Bounce a
  // signed-out visitor to sign-in with next back here, so deep-linking straight
  // to /checkout can't skip it. Wait for the session to resolve so a member is
  // not bounced on first paint; place-order is the server-side backstop anyway.
  React.useEffect(() => {
    if (!authLoading && !user) {
      router.replace(`${base}/sign-in?next=${encodeURIComponent(`${base}/checkout`)}`);
    }
  }, [authLoading, user, base, router]);

  if (!hydrated || authLoading) return null;
  if (!user) {
    // Backstop for the redirect above (and the instant before it navigates).
    return (
      <div className="container max-w-2xl pt-12 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
          <ShoppingBag className="h-7 w-7" />
        </div>
        <h1 className="mt-4 font-display text-2xl font-bold">{t('checkout.signIn.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('checkout.signIn.body')}</p>
        <Button
          variant="gradient"
          size="lg"
          className="mt-5"
          onClick={() =>
            router.replace(`${base}/sign-in?next=${encodeURIComponent(`${base}/checkout`)}`)
          }
        >
          {t('checkout.signIn.cta')}
        </Button>
      </div>
    );
  }
  // An order just went through: placeOrder cleared the cart and we're navigating to the
  // receipt. `submitting` stays true on success (only the error path resets it), so use it
  // to show a "redirecting" state here instead of flashing "Your cart is empty" in the gap
  // between clear() and the route change.
  if (submitting && lines.length === 0) {
    return (
      <div className="container max-w-2xl pt-16 text-center">
        <div className="mx-auto h-10 w-10 animate-spin rounded-full border-4 border-primary/25 border-t-primary" />
        <h1 className="mt-5 font-display text-2xl font-bold">{t('checkout.placed.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('checkout.placed.redirecting')}</p>
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="container max-w-2xl pt-12 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
          <ShoppingBag className="h-7 w-7" />
        </div>
        <h1 className="mt-4 font-display text-2xl font-bold">{t('checkout.empty.title')}</h1>
        <p className="mt-1 text-muted-foreground">{t('checkout.empty.body')}</p>
        {/* The cart can be emptied here by a refused order that took its last line out; without
            this the diner would see "empty" with no idea where their food went. */}
        {error && (
          <p className="mx-auto mt-3 max-w-md text-sm text-danger" role="alert">
            {error}
          </p>
        )}
        <Button variant="gradient" size="lg" className="mt-5" onClick={() => router.push(base)}>
          {t('checkout.empty.cta')}
        </Button>
      </div>
    );
  }

  const applyPromo = async () => {
    if (!promoCode.trim()) return;
    setPromoState({ status: 'validating' });
    const supabase = getBrowserClient();
    const { data, error } = await supabase.rpc('validate_promo_code', {
      p_branch_id: branchId,
      p_code: promoCode.trim(),
      p_subtotal: subtotal,
    });
    if (error) {
      // The raw text is for us, not the diner.
      console.error('validate_promo_code_failed', error.message);
      setPromoState({ status: 'error', code: 'request_failed' });
      return;
    }
    const r = data as {
      valid: boolean;
      error?: string;
      min_subtotal?: number;
      amount_off?: number;
      free_delivery?: boolean;
      promo_id?: string;
    };
    if (!r.valid) {
      setPromoState({
        status: 'error',
        code: r.error ?? 'invalid',
        minSubtotal: r.min_subtotal != null ? Number(r.min_subtotal) : undefined,
      });
      return;
    }
    setPromoState({
      status: 'applied',
      amount_off: Number(r.amount_off ?? 0),
      free_delivery: !!r.free_delivery,
      promo_id: r.promo_id ?? '',
    });
  };

  // validate_promo_code's refusal codes. Anything else — a failed request included — is the
  // generic error rather than a raw code on screen.
  const promoErrorText = (state: { code: string; minSubtotal?: number }): string => {
    switch (state.code) {
      case 'invalid':
      case 'invalid_code':
        return t('checkout.promo.errors.invalidCode');
      case 'promo_exhausted':
        return t('checkout.promo.errors.exhausted');
      // Only from place-order: the code stopped being offered after this page accepted it.
      case 'promo_unavailable':
        return t('checkout.promo.errors.unavailable');
      case 'min_subtotal_not_met':
        return state.minSubtotal != null && Number.isFinite(state.minSubtotal)
          ? t('checkout.promo.errors.minSubtotal', { amount: formatCurrency(state.minSubtotal) })
          : t('checkout.promo.errors.minSubtotalUnknown');
      case 'per_customer_limit_reached':
        return t('checkout.promo.errors.perCustomerLimit');
      default:
        return t('errors.generic');
    }
  };

  // check_gift_card's refusal codes, likewise.
  const giftCardErrorText = (code: string): string => {
    switch (code) {
      case 'invalid':
      case 'invalid_or_redeemed':
        return t('checkout.giftCard.errors.invalidOrRedeemed');
      case 'expired':
        return t('checkout.giftCard.errors.expired');
      default:
        return t('errors.generic');
    }
  };

  // "(optional)" after a field label, quieter than the label itself.
  const optionalHint = (chunks: React.ReactNode) => (
    <span className="font-normal text-muted-foreground">{chunks}</span>
  );

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // OrderTypeGate is covering the page — there is nothing to submit yet.
    if (!channel) return;

    // Defence in depth. This is the branch's own cart and it refuses anything added elsewhere,
    // so a line from another branch should not be able to reach this page. If one does anyway
    // it is taken out and the diner is told, rather than sent to a kitchen that does not sell
    // it — where it would sink the whole order.
    const foreignLines = lines.filter((l) => l.branchId !== branchId);
    if (foreignLines.length > 0) {
      for (const line of foreignLines) removeLine(line.id);
      setError(t('errors.order.itemUnavailable'));
      return;
    }

    // Validate every field up front, then focus the first problem.
    const errs: Record<string, string> = {};
    // 'later' with a cleared time would silently become ASAP server-side
    // (place-order derives the mode from scheduled_for) — and be gated
    // against the wrong payment matrix. Block it here. Dine-in never reaches
    // this: effectiveScheduleMode pins it to 'asap' and the card is hidden.
    if (effectiveScheduleMode === 'later' && !scheduledFor)
      errs.schedule = t('checkout.errors.scheduleRequired');
    // The list was measured when delivery was chosen, and filling in an address can take long
    // enough for the picked slot to fall inside the minimum lead time. Refresh the list (the
    // preselect effect re-points to the next valid slot) and ask the diner to confirm it, rather
    // than letting place-order answer scheduled_too_soon.
    else if (
      effectiveScheduleMode === 'later' &&
      scheduling &&
      Date.parse(scheduledFor) < Date.now() + Math.max(0, scheduling.minLeadMinutes) * 60_000
    ) {
      setSlotClock(new Date());
      errs.schedule = t('checkout.errors.scheduleStale');
    }
    if (!name.trim()) errs.name = t('checkout.errors.nameRequired');
    const phoneDigits = phone.replace(/\D/g, '');
    if (!phone.trim()) errs.phone = t('checkout.errors.phoneRequired');
    else if (phoneDigits.length < 10) errs.phone = t('checkout.errors.phoneInvalid');
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()))
      errs.email = t('checkout.errors.emailInvalid');
    if (channel === 'delivery') {
      if (!address.trim()) errs.address = t('checkout.errors.addressRequired');
      else if (enteringNewAddress && !addressCoords)
        errs.address = t('checkout.errors.addressUnconfirmed');
      if (!dropoffPref) errs.dropoff = t('checkout.errors.dropoffRequired');
      else if (dropoffPref === 'other' && !dropoffOther.trim())
        errs.dropoff = t('checkout.errors.dropoffOtherRequired');
    }
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      const firstEl = errs.schedule
        ? scheduleSectionRef.current
        : errs.name
          ? nameRef.current
          : errs.phone
            ? phoneRef.current
            : errs.email
              ? emailRef.current
              : errs.address
                ? addressSectionRef.current
                : errs.dropoff
                  ? dropoffSectionRef.current
                  : null;
      firstEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (firstEl && firstEl instanceof HTMLInputElement) firstEl.focus({ preventScroll: true });
      return;
    }
    setFieldErrors({});

    if (outOfRange) {
      setError(t('checkout.errors.outOfRange'));
      return;
    }
    if (deliveryNotSold) {
      setError(t('checkout.errors.deliveryNotSold'));
      return;
    }
    if (channel === 'delivery' && !deliveryBookable) {
      setError(t('errors.order.schedulingDisabled'));
      return;
    }
    if (channel === 'pickup' && !openNow) {
      setError(
        ordersPaused
          ? t('checkout.orderType.paused')
          : deliveryOfferable
            ? t('checkout.errors.pickupClosedScheduleInstead')
            : t('checkout.orderType.pickupClosed'),
      );
      return;
    }
    setSubmitting(true);
    try {
      const supabase = getBrowserClient();
      // Persist email on the customer row so receipts/notifications can reach
      // them. Prefer the resolved customer id — that is the same single row
      // account settings writes to and this page prefills from. Without it, fall
      // back to a branch-scoped update: each branch keeps its own record of the
      // diner, so an unscoped one would overwrite the email on every branch's
      // (and every other restaurant's) row.
      if (email.trim()) {
        const nextEmail = email.trim().toLowerCase();
        if (customerId) {
          await supabase.from('customers').update({ email: nextEmail }).eq('id', customerId);
        } else {
          const { data: user } = await supabase.auth.getUser();
          if (user.user) {
            await supabase
              .from('customers')
              .update({ email: nextEmail })
              .eq('user_id', user.user.id)
              .eq('branch_id', branchId);
          }
        }
      }

      // place-order v10.5 takes the sitting a dine-in round belongs to. PlaceOrderInput in
      // queries/orders.ts has not caught up with the field yet, so it is widened here
      // rather than asserted over the whole payload — the rest still type-checks.
      const orderInput: PlaceOrderInput & { session_id?: string } = {
        branch_id: branchId,
        channel,
        customer_name: name,
        customer_phone: phone,
        customer_notes: atTable
          ? `${pinnedTable!.label}${notes ? ` — ${notes}` : ''}`
          : notes || undefined,
        // A scanned table is already a row id, so place-order stores the FK instead of
        // string-matching a number. Dine-in only ever comes from a scan now, so there is
        // no typed number to fall back to.
        table_id: atTable ? pinnedTable!.id : undefined,
        // The sitting this round joins. place-order refuses a dine-in web order whose table
        // has no open session, or whose caller never joined it, so this is what makes the
        // round land on the party's bill instead of starting a private one.
        session_id: atTable ? pinnedTable!.sessionId : undefined,
        // Structured too, so place-order can resolve it to a real tables row and
        // the kitchen/floor plan stop relying on the notes prefix above.
        table_number: atTable ? pinnedTable!.number : undefined,
        delivery_address:
          channel === 'delivery'
            ? {
                line1: address,
                line2: addressMeta?.line2,
                city: addressMeta?.city,
                state: addressMeta?.state,
                postal_code: addressMeta?.postal_code,
                notes: addressNotes.trim() || undefined,
                dropoff_pref: dropoffPref ?? undefined,
                dropoff_other: dropoffPref === 'other' ? dropoffOther.trim() : undefined,
                gate_code: gateCode.trim() || undefined,
                room: room.trim() || undefined,
                lat: addressCoords?.lat,
                lng: addressCoords?.lng,
              }
            : undefined,
        saved_address_id:
          selectedAddressId && selectedAddressId !== 'new' ? selectedAddressId : undefined,
        // Dine-in has no payment step: 'cash' is "pay at the restaurant", and the
        // only value that neither trips the card_payment entitlement nor breaks
        // the NOT NULL payments.method column.
        payment_method: effectivePaymentMethod,
        // Send the reward only when it is actually applicable — appliedReward is
        // already null if the identity check failed or the cart drifted, so the
        // server is never asked to honour something the summary did not show.
        reward_id: appliedReward?.id,
        tip_amount: tipAmount || undefined,
        promo_code: promoState.status === 'applied' ? promoCode.trim() : undefined,
        // Belt and braces on top of effectiveScheduleMode — no state, however
        // stale, can smuggle a scheduled_for onto a dine-in order.
        scheduled_for:
          !isDineIn && effectiveScheduleMode === 'later' && scheduledFor
            ? scheduledFor
            : undefined,
        gift_card_code: giftCardState.status === 'valid' ? giftCardCode.trim() : undefined,
        items: lines
          .filter((l) => !l.comboId)
          .map((l) => ({
            menu_item_id: l.menuItemId,
            quantity: l.quantity,
            notes: l.notes,
            modifier_option_ids: l.modifiers?.map((m) => m.option_id),
          })),
        combos: lines
          .filter((l) => l.comboId)
          .map((l) => ({
            combo_id: l.comboId!,
            quantity: l.quantity,
            notes: l.notes,
          })),
      };

      const result = await placeOrder(supabase, orderInput);

      // Save the address (with coordinates) if it was a new entry and the
      // customer is signed in. Best-effort — the order already went through.
      if (channel === 'delivery' && selectedAddressId === 'new' && address && customerId) {
        await upsertCustomerAddress(supabase, {
          customer_id: customerId,
          line1: address,
          line2: addressMeta?.line2 ?? null,
          city: addressMeta?.city ?? null,
          state: addressMeta?.state ?? null,
          postal_code: addressMeta?.postal_code ?? null,
          lat: addressCoords?.lat ?? null,
          lng: addressCoords?.lng ?? null,
          notes: addressNotes.trim() || null,
          is_default: savedAddresses.length === 0,
        }).catch(() => undefined);
      }
      clear();
      // Invalidate the client Router Cache before navigating: the order was placed by a
      // direct fetch to the edge function, so Next has no idea the data changed. Without
      // this, /orders (and rewards) can render a cached tree from before the order and the
      // diner does not see the order they just placed.
      router.refresh();
      router.push(`${base}/orders/${result.order_number}`);
    } catch (err) {
      const raw = (err as Error).message;
      const body = placeOrderBody(raw);
      // A promo code or gift card this page accepted was refused when the order was placed (used
      // up, switched off, spent elsewhere). Put the reason in that code's own box, the way
      // Apply shows it, which also takes the credit off the total on screen: pressing the button
      // again then orders at the price the diner can now see, or they fix the code first.
      if (body?.promo === true) {
        const min = Number(body.min_subtotal);
        setPromoState({
          status: 'error',
          code: typeof body.error === 'string' ? body.error : 'invalid_code',
          minSubtotal: body.min_subtotal != null && Number.isFinite(min) ? min : undefined,
        });
        setError(t('errors.order.promoRefused'));
        setSubmitting(false);
        return;
      }
      if (body?.error === 'gift_card_changed') {
        // `reason` is check_gift_card's (invalid_or_redeemed, expired). A refusal while the card is
        // being taken carries none: the card was spent in between.
        setGiftCardState({
          status: 'error',
          code: typeof body.reason === 'string' && body.reason ? body.reason : 'invalid_or_redeemed',
        });
        setError(t('errors.order.giftCardRefused'));
        setSubmitting(false);
        return;
      }
      // The server named the dish, combo or option it no longer offers. Take out exactly the lines
      // that use it — pressing the button again would only fail the same way — and say so. A code
      // with no id, or an id no line uses any more, falls through to the sentence below.
      const refused = refusedCartPart(raw);
      const refusedLines = refused ? linesUsing(lines, refused) : [];
      if (refused && refusedLines.length > 0) {
        // Before the lines go: a cart emptied while `submitting` is still true reads as an order
        // that went through (the "redirecting" state above).
        setSubmitting(false);
        // A dish or a set is named; an option can sink several different dishes, so it is not.
        const name = refused.kind === 'option' ? null : (refusedLines[0]?.name ?? null);
        setError(name ? t('errors.order.lineRemoved', { name }) : t('errors.order.itemRemoved'));
        for (const line of refusedLines) removeLine(line.id);
        return;
      }
      // Sold out or short on stock: name the dish, since the cart may hold several. The line stays;
      // the diner decides whether to lower the quantity or take it out.
      if (body && (body.error === 'item_sold_out' || body.error === 'insufficient_stock')) {
        const itemId = typeof body.item_id === 'string' ? body.item_id : null;
        const dish = itemId ? lines.find((l) => !l.comboId && l.menuItemId === itemId) : undefined;
        const available = Number(body.available);
        if (dish) {
          setError(
            body.error === 'insufficient_stock' && Number.isFinite(available) && available > 0
              ? t('errors.order.insufficientStockNamed', { name: dish.name, available })
              : t('errors.order.itemSoldOutNamed', { name: dish.name }),
          );
          setSubmitting(false);
          return;
        }
      }
      const key = orderErrorKey(raw);
      // A failure with no code we know is logged as it came and shown as the generic line —
      // a raw status and JSON body is no use to a diner.
      if (!key) console.error('place_order_failed', raw);
      setError(key ? t(key) : t('errors.generic'));
      setSubmitting(false);
    }
  };

  return (
    <div className="container max-w-2xl pt-4">
      <header className="mb-5 flex items-center gap-3">
        <IconButton label={t('common.back')} onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <h1 className="font-display text-2xl font-bold">{t('checkout.title')}</h1>
      </header>

      <form className="space-y-5" onSubmit={handleSubmit}>
        {/* The two ways to order: Pickup (prepared now) and Schedule Delivery (a booked day and
            time). This card used to be "When? ASAP | Schedule for later", a timing choice on top
            of an order type picked elsewhere; the timing now follows from the type. Dine-in never
            sees it — the order type is the table's, and it is always now. */}
        {!isDineIn && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">{t('orderType.title')}</h2>
            <div
              role="radiogroup"
              aria-label={t('orderType.title')}
              className="mt-3 flex rounded-full bg-muted p-1 text-sm font-semibold"
            >
              <button
                type="button"
                role="radio"
                aria-checked={channel === 'pickup'}
                disabled={!pickupAvailable}
                onClick={() => chooseOrderType('pickup')}
                className={`focus-ring flex-1 rounded-full py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  channel === 'pickup' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                {t('channel.pickup')}
              </button>
              {/* Not offered at all when the restaurant does not sell delivery, as on the menu: a
                  greyed option would only advertise something the diner cannot have. */}
              {canDeliver && (
                <button
                  type="button"
                  role="radio"
                  aria-checked={channel === 'delivery'}
                  disabled={!deliveryBookable}
                  onClick={() => chooseOrderType('delivery')}
                  className={`focus-ring flex-1 rounded-full py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    channel === 'delivery' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                  }`}
                >
                  {t('channel.delivery')}
                </button>
              )}
            </div>
            {channel === 'pickup' && !openNow && (
              <p className="mt-2 text-xs text-muted-foreground">
                {ordersPaused
                  ? t('checkout.orderType.paused')
                  : deliveryOfferable
                    ? t('checkout.orderType.pickupClosedCanSchedule')
                    : t('checkout.orderType.pickupClosed')}
              </p>
            )}
            {channel === 'pickup' && openNow && !asapPayable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {deliveryOfferable
                  ? t('checkout.orderType.pickupNoPaymentCanSchedule')
                  : t('checkout.orderType.pickupNoPayment')}
              </p>
            )}
            {channel === 'pickup' && pickupAvailable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('checkout.orderType.pickupReady')}
              </p>
            )}
            {channel === 'delivery' && !canDeliver && (
              <p className="mt-2 text-xs text-muted-foreground">
                {pickupAvailable
                  ? t('checkout.orderType.deliveryUnavailablePickupOpen')
                  : t('checkout.orderType.deliveryUnavailable')}
              </p>
            )}
            {channel === 'delivery' && canDeliver && !scheduledPayable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {pickupAvailable
                  ? t('checkout.orderType.deliveryNoPaymentPickupOpen')
                  : t('checkout.orderType.deliveryNoPayment')}
              </p>
            )}
            {/* A greyed-out Pickup with no reason reads as a broken button. */}
            {channel === 'delivery' && !pickupAvailable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {openNow
                  ? t('checkout.orderType.pickupNoPayment')
                  : ordersPaused
                    ? t('checkout.orderType.pickupPaused')
                    : t('checkout.orderType.pickupClosedNow')}
              </p>
            )}
            {/* Day and time, drawn from the branch's opening hours, booking windows, closures and
                delivery hours. The old free-form datetime-local let a diner pick a moment the
                branch is shut and only told them after they had filled in the entire form. */}
            {channel === 'delivery' && deliveryBookable && (
              <div ref={scheduleSectionRef} className="mt-3">
                {!bookingPolicy ? (
                  <p role="status" className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                    {t('checkout.schedule.loading')}
                  </p>
                ) : scheduleDays.length === 0 ? (
                  <p className="rounded-xl bg-muted px-4 py-3 text-sm text-muted-foreground">
                    {t('checkout.schedule.none')}
                  </p>
                ) : (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t('checkout.schedule.day')}</span>
                        <select
                          value={selectedDay?.date ?? ''}
                          onChange={(e) => {
                            const next = scheduleDays.find((d) => d.date === e.target.value);
                            setScheduleDate(e.target.value);
                            // Re-point at that day's first slot: keeping the old time would
                            // silently carry a moment the new day may not even be open.
                            setScheduledFor(next?.slots[0]?.iso ?? '');
                            clearFieldError('schedule');
                          }}
                          className="input"
                        >
                          {scheduleDays.map((d) => (
                            <option key={d.date} value={d.date}>{d.label}</option>
                          ))}
                        </select>
                      </label>
                      <label className="block">
                        <span className="mb-1 block text-sm font-medium">{t('checkout.schedule.time')}</span>
                        <select
                          value={scheduledFor}
                          onChange={(e) => { setScheduledFor(e.target.value); clearFieldError('schedule'); }}
                          aria-invalid={!!fieldErrors.schedule}
                          className="input"
                          style={fieldErrors.schedule ? { borderColor: 'hsl(var(--danger))' } : undefined}
                        >
                          {(selectedDay?.slots ?? []).map((sl) => (
                            <option key={sl.iso} value={sl.iso}>{sl.label}</option>
                          ))}
                        </select>
                      </label>
                    </div>
                    {fieldErrors.schedule && (
                      <p className="mt-1 text-xs text-danger">{fieldErrors.schedule}</p>
                    )}
                    <p className="mt-2 text-xs text-muted-foreground">
                      {t('checkout.schedule.hint')}
                    </p>
                  </>
                )}
              </div>
            )}
          </Card>
        )}

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('checkout.contactInfo')}</h2>
          <div className="mt-3 grid gap-3">
            <Field label={t('checkout.name')}>
              <input
                ref={nameRef}
                value={name}
                onChange={(e) => { setName(e.target.value); clearFieldError('name'); }}
                required
                autoComplete="name"
                placeholder={t('checkout.namePlaceholder')}
                aria-invalid={!!fieldErrors.name}
                className="input"
                style={fieldErrors.name ? { borderColor: 'hsl(var(--danger))' } : undefined}
              />
              {fieldErrors.name && <p className="mt-1 text-xs text-danger">{fieldErrors.name}</p>}
            </Field>
            <Field label={t('checkout.phone')}>
              <input
                ref={phoneRef}
                value={phone}
                onChange={(e) => { setPhone(e.target.value); clearFieldError('phone'); }}
                required
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                placeholder={t('checkout.phonePlaceholder')}
                aria-invalid={!!fieldErrors.phone}
                className="input"
                style={fieldErrors.phone ? { borderColor: 'hsl(var(--danger))' } : undefined}
              />
              {fieldErrors.phone && <p className="mt-1 text-xs text-danger">{fieldErrors.phone}</p>}
            </Field>
            <div className="sm:col-span-2">
              <Field label={t('checkout.emailLabel')}>
                <input
                  ref={emailRef}
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); clearFieldError('email'); }}
                  type="email"
                  inputMode="email"
                  autoComplete="email"
                  placeholder={t('checkout.emailPlaceholder')}
                  aria-invalid={!!fieldErrors.email}
                  className="input"
                  style={fieldErrors.email ? { borderColor: 'hsl(var(--danger))' } : undefined}
                />
                {fieldErrors.email && <p className="mt-1 text-xs text-danger">{fieldErrors.email}</p>}
              </Field>
            </div>
          </div>
        </Card>

        {channel === 'delivery' && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">{t('checkout.deliveryAddress')}</h2>
            {savedAddresses.length > 0 && (
              <div className="mt-3 space-y-2">
                {savedAddresses.map((a) => (
                  <label
                    key={a.id}
                    className={`flex cursor-pointer items-start gap-2 rounded-xl border p-3 transition ${
                      selectedAddressId === a.id ? 'border-primary bg-primary/5' : 'border-border bg-card'
                    }`}
                  >
                    <input
                      type="radio"
                      name="address"
                      checked={selectedAddressId === a.id}
                      onChange={() => {
                        setSelectedAddressId(a.id);
                        setAddress([a.address_line1, a.address_line2].filter(Boolean).join(', '));
                        setAddressCoords(
                          a.lat != null && a.lng != null ? { lat: a.lat, lng: a.lng } : null,
                        );
                        setAddressMeta(null);
                      }}
                      className="mt-1"
                    />
                    <div className="flex-1">
                      <p className="flex items-center gap-2 font-medium">
                        <MapPin className="h-4 w-4 text-muted-foreground" />
                        {a.label ?? t('checkout.address')}
                        {a.is_default && <Badge variant="muted">{t('checkout.addresses.default')}</Badge>}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {[a.address_line1, a.address_line2, a.city, a.state].filter(Boolean).join(', ')}
                      </p>
                    </div>
                  </label>
                ))}
                <button
                  type="button"
                  onClick={() => {
                    setSelectedAddressId('new');
                    setAddress('');
                    resolvedAddressRef.current = null;
                    setAddressCoords(null);
                    setAddressMeta(null);
                  }}
                  className={`w-full rounded-xl border border-dashed px-3 py-2 text-sm font-medium ${
                    selectedAddressId === 'new'
                      ? 'border-primary text-primary'
                      : 'border-border text-muted-foreground'
                  }`}
                >
                  {t('checkout.addresses.useNew')}
                </button>
              </div>
            )}
            {enteringNewAddress && (
              <div ref={addressSectionRef}>
                <Field label={t('checkout.address')}>
                  <AddressAutofillInput
                    value={address}
                    onChange={(text) => {
                      setAddress(text);
                      clearFieldError('address');
                      // Mapbox fills the input to the resolved line1 (firing onChange
                      // right after onResolved). Only invalidate the pin when the text
                      // actually diverges from the resolved address — otherwise the
                      // autofill's own input event would wipe the coords we just set.
                      if (text !== resolvedAddressRef.current) {
                        resolvedAddressRef.current = null;
                        setAddressCoords(null);
                        setAddressMeta(null);
                      }
                    }}
                    onResolved={(a) => {
                      resolvedAddressRef.current = a.line1;
                      setAddressCoords({ lat: a.lat, lng: a.lng });
                      setAddressMeta({
                        line2: a.line2,
                        city: a.city,
                        state: a.state,
                        postal_code: a.postal_code,
                      });
                      clearFieldError('address');
                    }}
                    required
                    placeholder={t('checkout.addressPlaceholder')}
                    locale={locale}
                    inputClassName="input"
                    aria-label={t('checkout.address')}
                  />
                </Field>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    leftIcon={<MapIcon className="h-4 w-4" />}
                    onClick={() => setPickerOpen(true)}
                  >
                    {t('checkout.setOnMap')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    leftIcon={<LocateFixed className="h-4 w-4" />}
                    loading={locatingQuick}
                    onClick={handleQuickCurrentLocation}
                  >
                    {t('checkout.useCurrentLocation')}
                  </Button>
                </div>
                {geoError && <p className="mt-2 text-xs text-warning">{geoError}</p>}
                {fieldErrors.address && (
                  <p className="mt-2 text-xs font-medium text-danger">{fieldErrors.address}</p>
                )}
                {addressCoords && resolvedAddressRef.current && (
                  <p className="mt-2 flex items-center gap-1 text-xs font-medium text-success">
                    <MapPin className="h-3.5 w-3.5" /> {t('checkout.addresses.pinned')}
                  </p>
                )}
              </div>
            )}
            {quoting && (
              <p className="mt-2 text-xs text-muted-foreground">{t('checkout.quote.calculating')}</p>
            )}
            {!quoting && quote?.deliverable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {/* No "ready in N min": every storefront delivery is booked for a chosen time,
                    and the quote's ETA is measured from now. */}
                {t('checkout.quote.distanceFee', {
                  distance: kmToMi(quote.distance_km).toFixed(1),
                  fee: formatCurrency(quote.fee),
                })}
              </p>
            )}
            {outOfRange && (
              <p className="mt-2 text-sm font-medium text-danger">
                {!quote.deliverable && quote.radius_km
                  ? t('checkout.quote.outOfRangeMax', { max: kmToMi(quote.radius_km).toFixed(1) })
                  : t('errors.order.deliveryOutOfRange')}
              </p>
            )}
            {deliveryNotSold && (
              <p className="mt-2 text-sm font-medium text-danger" role="alert">
                {t('checkout.quote.notSold')}
              </p>
            )}
            {enteringNewAddress && !addressCoords && !quoting && address.trim().length > 3 && (
              <p className="mt-2 text-xs font-medium text-warning">
                {t('checkout.quote.pickSuggestion')}
              </p>
            )}

            <div className="mt-4" ref={dropoffSectionRef}>
              <label className="mb-1 block text-sm font-medium">{t('checkout.dropoff.title')}</label>
              <div className="grid grid-cols-2 gap-2">
                {DROPOFF_OPTIONS.map((value) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => { setDropoffPref(value); clearFieldError('dropoff'); }}
                    aria-pressed={dropoffPref === value}
                    className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                      dropoffPref === value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-card'
                    }`}
                    style={
                      fieldErrors.dropoff && !dropoffPref
                        ? { borderColor: 'hsl(var(--danger))' }
                        : undefined
                    }
                  >
                    {t(`checkout.dropoff.options.${value}`)}
                  </button>
                ))}
              </div>
              {dropoffPref === 'other' && (
                <input
                  value={dropoffOther}
                  onChange={(e) => { setDropoffOther(e.target.value); clearFieldError('dropoff'); }}
                  placeholder={t('checkout.dropoff.otherPlaceholder')}
                  maxLength={120}
                  aria-invalid={!!fieldErrors.dropoff}
                  className="input mt-2"
                  style={fieldErrors.dropoff ? { borderColor: 'hsl(var(--danger))' } : undefined}
                />
              )}
              {fieldErrors.dropoff && (
                <p className="mt-2 text-xs font-medium text-danger">{fieldErrors.dropoff}</p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">
                    {t.rich('checkout.dropoff.gateCode', { optional: optionalHint })}
                  </span>
                  <input
                    value={gateCode}
                    onChange={(e) => setGateCode(e.target.value)}
                    maxLength={40}
                    placeholder={t('checkout.dropoff.gateCodePlaceholder')}
                    className="input"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">
                    {t.rich('checkout.dropoff.room', { optional: optionalHint })}
                  </span>
                  <input
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                    maxLength={40}
                    placeholder={t('checkout.dropoff.roomPlaceholder')}
                    className="input"
                  />
                </label>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium">
                {t.rich('checkout.dropoff.instructions', { optional: optionalHint })}
              </label>
              <textarea
                value={addressNotes}
                onChange={(e) => setAddressNotes(e.target.value)}
                placeholder={t('checkout.dropoff.instructionsPlaceholder')}
                rows={2}
                maxLength={300}
                className="focus-ring w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-base placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                {t('checkout.dropoff.instructionsHint')}
              </p>
            </div>
          </Card>
        )}

        {/* Keyed off the pin, not off the channel. Dine-in is only ever reached by
            scanning the table, so there is no longer a table to ask for — and a
            dine_in restored from storage still has nothing to show here until the
            provider has checked the sitting, which ends with either a pin or the
            gate reopening. */}
        {atTable && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">{t('channel.dineIn')}</h2>
            <p className="mt-3 rounded-xl bg-primary/10 px-3 py-2 font-display text-lg font-semibold text-primary">
              {pinnedTable!.label}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('checkout.dineIn.scanned')}
            </p>
            {/* Which round this is, and what the table already owes. The number is the
                whole party's, not this phone's: everyone who scanned the same tent is
                adding to one bill, and that is the figure they will be asked to pay. */}
            {tableBill && tableBill.order_count > 0 && (
              <p className="mt-1 text-xs text-muted-foreground">
                {t('checkout.dineIn.roundTotal', {
                  round: tableBill.order_count + 1,
                  amount: formatCurrency(Number(tableBill.running_total)),
                })}
              </p>
            )}
            {/* The last point at which a wrong table is still cheap to fix. After this
                the order carries the table id and the food is walked to it. */}
            <LeaveTableButton className="mt-2 px-0" />
            <p className="mt-3 text-xs text-muted-foreground">{t('checkout.dineInPayAtRestaurant')}</p>
          </Card>
        )}

        {/* Dine-in never picks a method — it is paid at the restaurant, and the
            checkout sends 'cash' on its behalf. */}
        {!isDineIn && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">{t('checkout.paymentMethod')}</h2>
            <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {paymentMatrix[paymentModeKey].card && (
                <PaymentChoice icon={<CreditCard className="h-5 w-5" />} label={t('checkout.payment.card')} active={method === 'card'} onClick={() => setMethod('card')} />
              )}
              {paymentMatrix[paymentModeKey].cash && (
                <PaymentChoice icon={<Banknote className="h-5 w-5" />} label={t('checkout.payment.cash')} active={method === 'cash'} onClick={() => setMethod('cash')} />
              )}
              {paymentMatrix[paymentModeKey].transfer && (
                <PaymentChoice icon={<QrCode className="h-5 w-5" />} label={t('checkout.payment.transfer')} active={method === 'transfer'} onClick={() => setMethod('transfer')} />
              )}
            </div>
            {/* Said once, next to the tiles, rather than only in the summary — the fee
                is the reason the total moves when they tap another method. */}
            {serviceFeePercent > 0 && paymentMatrix[paymentModeKey].card && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('checkout.payment.cardFeeNote', { percent: serviceFeePercent })}
              </p>
            )}
            {/* The QR itself has moved to the order page. Showing it here asked the diner to
                pay before the order existed — nothing to attach the slip to, no order number
                to quote in the transfer note, and no way back if checkout then failed. Here
                they only choose the method; the code, the amount and the upload all live on
                the tracking screen a moment later. */}
            {method === 'transfer' && (
              <p className="mt-3 rounded-2xl border border-border bg-muted/30 px-4 py-3 text-xs text-muted-foreground">
                {t('checkout.payment.transferNote')}
              </p>
            )}
            {cardWithheld && (
              <p role="status" className="mt-3 rounded-2xl bg-warning/10 px-4 py-3 text-xs text-warning">
                {enabledMethods.length > 0
                  ? t('checkout.payment.cardWithheldChooseOther')
                  : t('checkout.payment.cardWithheldOnly')}
              </p>
            )}
            {enabledMethods.length === 0 && !cardWithheld && (
              <p className="mt-3 text-sm text-muted-foreground">
                {t('checkout.payment.noneAvailable')}
              </p>
            )}
          </Card>
        )}

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <Tag className="h-4 w-4" /> {t('checkout.promo.title')}
          </h2>
          {promoState.status === 'applied' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl bg-success/10 px-3 py-2">
              <span className="text-sm text-success font-medium">
                {promoState.free_delivery
                  ? t('checkout.promo.appliedFreeDelivery', {
                      code: promoCode,
                      amount: formatCurrency(promoState.amount_off),
                    })
                  : t('checkout.promo.applied', {
                      code: promoCode,
                      amount: formatCurrency(promoState.amount_off),
                    })}
              </span>
              <button
                type="button"
                onClick={() => { setPromoCode(''); setPromoState({ status: 'idle' }); }}
                className="text-xs text-muted-foreground underline"
              >
                {t('checkout.remove')}
              </button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <input
                value={promoCode}
                onChange={(e) => setPromoCode(e.target.value.toUpperCase())}
                placeholder="WELCOME10"
                className="input flex-1"
              />
              <Button type="button" variant="ghost" onClick={applyPromo} loading={promoState.status === 'validating'}>
                {t('checkout.apply')}
              </Button>
            </div>
          )}
          {promoState.status === 'error' && (
            <p className="mt-2 text-xs text-destructive">{promoErrorText(promoState)}</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            {t('checkout.giftCard.title')}
          </h2>
          {giftCardState.status === 'valid' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl bg-success/10 px-3 py-2">
              <span className="text-sm font-medium text-success">
                {t('checkout.giftCard.applied', {
                  code: giftCardCode,
                  amount: formatCurrency(giftCardCredit),
                  balance: formatCurrency(giftCardState.balance),
                })}
              </span>
              <button
                type="button"
                onClick={() => { setGiftCardCode(''); setGiftCardState({ status: 'idle' }); }}
                className="text-xs text-muted-foreground underline"
              >
                {t('checkout.remove')}
              </button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <input
                value={giftCardCode}
                onChange={(e) => setGiftCardCode(e.target.value.toUpperCase())}
                placeholder={t('checkout.giftCard.placeholder')}
                className="input flex-1"
              />
              <Button type="button" variant="ghost" onClick={checkGiftCard} loading={giftCardState.status === 'checking'}>
                {t('checkout.apply')}
              </Button>
            </div>
          )}
          {giftCardState.status === 'error' && (
            <p className="mt-2 text-xs text-destructive">{giftCardErrorText(giftCardState.code)}</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('checkout.tip.title')}</h2>
          <p className="text-xs text-muted-foreground">
            {channel === 'delivery'
              ? tipWorkerPct < 100
                ? t('checkout.tip.driverPartial', { percent: tipWorkerPct })
                : t('checkout.tip.driverAll', { percent: tipWorkerPct })
              : tipWorkerPct < 100
                ? t('checkout.tip.teamPartial', { percent: tipWorkerPct })
                : t('checkout.tip.teamAll', { percent: tipWorkerPct })}
          </p>
          {/* Exactly five choices, one grid. On a phone the three percentages
              share the first row; Custom and "No tip" split the second, with No
              tip tucked in the corner at the same footprint as a percent chip.
              From sm up all five sit on one row. "No tip" is deliberately the
              quiet one: smaller muted text, no card fill, and even when it is the
              current choice it takes a neutral grey rather than the brand
              highlight, so the eye lands on the percentages first. */}
          <div className="mt-3 grid grid-cols-6 gap-2 sm:grid-cols-5">
            {tipPresets.map((p) => {
              const active = !tipCustom && !customTip && tipPercent === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  // Tapping the selected chip again clears it.
                  onClick={() => {
                    setTipCustom(false);
                    setCustomTip('');
                    setTipPercent(active ? 0 : p);
                  }}
                  className={`focus-ring col-span-2 rounded-xl border px-2 py-2 text-sm font-medium transition sm:col-span-1 ${
                    active ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
                  }`}
                >
                  {p}%
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={tipCustom}
              onClick={() => {
                setTipCustom(true);
                setTipPercent(0);
              }}
              className={`focus-ring col-span-4 rounded-xl border px-2 py-2 text-sm font-medium transition sm:col-span-1 ${
                tipCustom ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
              }`}
            >
              {t('checkout.tip.custom')}
            </button>
            <button
              type="button"
              aria-pressed={noTipSelected}
              onClick={() => {
                setTipCustom(false);
                setTipPercent(0);
                setCustomTip('');
              }}
              className={`focus-ring col-span-2 rounded-xl border px-2 py-2 text-xs font-medium transition sm:col-span-1 ${
                noTipSelected
                  ? 'border-border bg-muted text-foreground'
                  : 'border-transparent bg-transparent text-muted-foreground hover:border-border'
              }`}
            >
              {t('checkout.tip.none')}
            </button>
          </div>
          {tipCustom && (
            <input
              value={customTip}
              onChange={(e) => setCustomTip(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder={t('checkout.tip.customPlaceholder')}
              inputMode="decimal"
              aria-label={t('checkout.tip.customLabel')}
              className="input mt-2"
            />
          )}
        </Card>

        {rewards.length > 0 && (
          <Card className="p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-lg font-semibold">{t('checkout.rewards.title')}</h2>
              <span className="text-sm text-muted-foreground">
                {t.rich('checkout.rewards.balance', {
                  balance: pointsBalance,
                  strong: (chunks) => <strong>{chunks}</strong>,
                })}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t('checkout.rewards.onePerOrder')}
            </p>
            <div className="mt-3 space-y-2">
              {rewards.map((r) => {
                const blocker = rewardBlocker(r);
                const selected = rewardId === r.id;
                const off = loyaltyRewardDiscount(r, subtotal);
                return (
                  <button
                    key={r.id}
                    type="button"
                    // Blocked rewards stay visible and pressable-looking but inert,
                    // so the diner learns what to do (add the item, spend $5 more)
                    // instead of hunting for a reward that silently vanished.
                    aria-pressed={selected}
                    disabled={!!blocker || !identityVerified}
                    onClick={() => setRewardId(selected ? null : r.id)}
                    className={`flex w-full items-center gap-3 rounded-2xl border p-3 text-left transition ${
                      selected
                        ? 'border-primary bg-primary/5'
                        : 'border-border/60 hover:border-primary/40'
                    } ${blocker || !identityVerified ? 'opacity-55' : ''}`}
                  >
                    <span
                      aria-hidden
                      className={`h-4 w-4 shrink-0 rounded-full border-2 ${
                        selected ? 'border-primary bg-primary' : 'border-border'
                      }`}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{r.name}</span>
                      <span className="block truncate text-xs text-muted-foreground">
                        {t('checkout.rewards.cost', { points: r.points_cost })}
                        {r.description ? ` · ${r.description}` : ''}
                        {blocker ? ` · ${blocker}` : ''}
                      </span>
                    </span>
                    <span className="shrink-0 text-right font-display text-sm font-bold text-primary tabular-nums">
                      {r.kind === 'free_delivery' ? t('checkout.rewards.freeDelivery') : `-${formatCurrency(off)}`}
                    </span>
                  </button>
                );
              })}
            </div>
            {!identityVerified && (
              <p className="mt-2 text-xs text-muted-foreground">
                {t('checkout.loyalty.verifyHint')}{' '}
                <Link
                  href={`${base}/account`}
                  className="font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t('checkout.loyalty.verifyCta')}
                </Link>
              </p>
            )}
          </Card>
        )}

        <Card className="p-5">
          <dl className="space-y-2 text-sm">
            <Row label={t('cart.subtotal')} value={formatCurrency(subtotal)} />
            {/* Only on a delivery order. A pickup bill used to carry "Delivery fee $0.00", which
                read as a delivery order whose address the checkout had simply failed to ask for. */}
            {channel === 'delivery' && (
              <Row
                label={t('cart.deliveryFee')}
                value={
                  quoting
                    ? t('checkout.summary.calculating')
                    : enteringNewAddress && !addressCoords
                      ? '—'
                      : formatCurrency(deliveryFee)
                }
              />
            )}
            {/* Only where the branch actually charges them — a branch with no
                service fee or no tax showing a $0.00 line is noise. Same labels
                as the receipt. */}
            {serviceFee > 0 && <Row label={t('cart.serviceFee')} value={formatCurrency(serviceFee)} />}
            {salesTaxRate > 0 && <Row label={t('checkout.summary.salesTax')} value={formatCurrency(taxAmount)} />}
            {tipAmount > 0 && <Row label={t('checkout.summary.tip')} value={formatCurrency(tipAmount)} />}
            {promoDiscount > 0 && <Row label={t('checkout.summary.promo', { code: promoCode })} value={`-${formatCurrency(promoDiscount)}`} />}
            {appliedReward && (
              <Row
                label={t('checkout.summary.reward', { name: appliedReward.name })}
                value={
                  loyaltyDollarsOff > 0
                    ? `-${formatCurrency(loyaltyDollarsOff)}`
                    : // free_delivery zeroes the delivery fee row above rather than
                      // discounting the food, so a -$ figure here would double-count it.
                      t('checkout.summary.deliveryFree')
                }
              />
            )}
            <div className="my-2 h-px bg-border" />
            <Row label={t('cart.total')} value={formatCurrency(total)} bold />
          </dl>
        </Card>

        {error && (
          <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">
            {t.rich('checkout.submitError', {
              error,
              strong: (chunks) => <strong>{chunks}</strong>,
            })}
          </Card>
        )}

        <motion.div
          initial={{ y: 40, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ delay: 0.05 }}
          className="sticky bottom-16 lg:bottom-0 lg:pb-4"
        >
          <Button
            variant="gradient"
            size="xl"
            fullWidth
            type="submit"
            loading={submitting}
            disabled={
              !channel ||
              outOfRange ||
              deliveryNotSold ||
              // Dine-in doesn't pay online, so an all-off ASAP matrix must not
              // disable it — the card that explains why is hidden for dine-in,
              // and a dead button with no reason is worse than no button.
              (!isDineIn && enabledMethods.length === 0) ||
              (channel === 'pickup' && !openNow) ||
              (channel === 'delivery' && (!deliveryBookable || (deliverySlotsKnown && !deliveryHasSlots))) ||
              (channel === 'delivery' && quoting) ||
              (channel === 'delivery' && enteringNewAddress && !addressCoords)
            }
          >
            {/* At a table nothing is being paid for here — the round goes to the kitchen and
                the bill is settled with a server at the end of the meal. "Place order" read
                as the last step of a transaction that has not happened yet. */}
            {atTable
              ? t('checkout.sendToKitchen', { amount: formatCurrency(total) })
              : t('checkout.placeOrder', { amount: formatCurrency(total) })}
          </Button>
        </motion.div>
      </form>

      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        side="bottom"
        title={t('checkout.picker.title')}
      >
        <LocationPicker
          className="h-[70vh]"
          initial={addressCoords}
          fallbackCenter={branchCenter}
          onConfirm={(a) => {
            applyResolvedAddress(a);
            setPickerOpen(false);
          }}
          labels={pickerLabels(t)}
          locale={locale}
        />
      </Sheet>

      <style jsx global>{`
        .input {
          width: 100%;
          height: 48px;
          padding: 0 1rem;
          font-size: 16px;
          border-radius: 0.875rem;
          border: 1px solid hsl(var(--border));
          background: hsl(var(--background));
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .input:focus-visible {
          border-color: hsl(var(--primary));
          box-shadow: 0 0 0 3px hsl(var(--primary) / 0.18);
        }
      `}</style>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium">{label}</span>
      {children}
    </label>
  );
}

function PaymentChoice({ icon, label, active, onClick }: { icon: React.ReactNode; label: string; active: boolean; onClick: () => void }) {
  return (
    <motion.button
      type="button"
      whileTap={{ scale: 0.97 }}
      onClick={onClick}
      className={`focus-ring flex min-h-touch items-center gap-2 rounded-xl border px-4 py-3 text-sm font-semibold transition-all ${
        active ? 'border-primary bg-primary/10 text-primary shadow-soft' : 'border-border bg-card text-foreground hover:border-primary/40'
      }`}
    >
      {icon}
      {label}
    </motion.button>
  );
}

function Row({ label, value, bold }: { label: string; value: string; bold?: boolean }) {
  return (
    <div className={`flex items-center justify-between ${bold ? 'text-base font-bold' : ''}`}>
      <dt>{label}</dt>
      <dd className={bold ? 'font-display text-xl text-primary' : ''}>{value}</dd>
    </div>
  );
}
