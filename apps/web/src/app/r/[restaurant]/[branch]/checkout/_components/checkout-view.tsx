'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Banknote, ChevronLeft, CreditCard, LocateFixed, Map as MapIcon, MapPin, ShoppingBag, Tag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import {
  computeSalesTax,
  formatCurrency,
  kmToMi,
  parseTipConfig,
  tipPresetsForChannel,
  TIP_CONFIG_DEFAULTS,
  type TipConfig,
} from '@favornoms/shared';
import { getBrowserClient } from '@favornoms/database/client';
import {
  getMyLoyalty,
  listCustomerAddresses,
  placeOrder,
  quoteDelivery,
  upsertCustomerAddress,
  type DeliveryQuote,
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
import { pickerLabels } from '@/lib/picker-labels';
import { useCart } from '@/store/cart';
import { useAuth } from '@/components/auth/use-auth';

type PaymentMethod = 'card' | 'cash';
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
  return {
    asap: { cash: read('asap', 'cash'), card: read('asap', 'card') },
    scheduled: { cash: read('scheduled', 'cash'), card: read('scheduled', 'card') },
  };
}

// The `customer-auth` edge function mints phone-only diners as synthetic
// `c{digits}@customer.favornoms.local` users with `email_confirm: true`, so they
// carry a provider-'email' identity that proves nothing. Excluding this domain is
// what keeps the loyalty gate meaningful. place-order excludes the same domain —
// keep both in sync with EMAIL_DOMAIN in supabase/functions/customer-auth/index.ts.
const SYNTHETIC_CUSTOMER_EMAIL_SUFFIX = '@customer.favornoms.local';

// place-order's error codes, rendered for a customer.
//
// The billing codes (402 billing_inactive / 403 feature_not_entitled) are
// deliberately phrased as restaurant availability: the customer is not the
// party who owes anything, and telling them the restaurant hasn't paid is a
// reputational hit we have no right to inflict. Order is significant —
// `dropoff_other_required` contains `dropoff_required` as a substring.
const ORDER_ERRORS: Array<[string, string]> = [
  ['billing_inactive', 'This restaurant is not taking online orders right now. Please try again later.'],
  ['feature_not_entitled:delivery', 'This restaurant is not offering delivery right now. Please choose pickup or dine-in.'],
  ['delivery_not_entitled', 'This restaurant is not offering delivery right now. Please choose pickup or dine-in.'],
  ['feature_not_entitled:card_payment', 'Card payment is not available here right now. Please pay with cash.'],
  ['branch_closed', 'This restaurant is currently closed. Please try again during opening hours.'],
  ['delivery_out_of_range', 'Sorry, this address is outside the delivery area.'],
  ['payment_method_not_accepted', 'That payment method is not available for this order type. Please pick another.'],
  ['dropoff_other_required', 'Please describe where we should leave your order.'],
  ['dropoff_required', 'Please choose where we should leave your order.'],
  ['table_required', 'Please enter your table number.'],
  ['invalid_channel', 'Please choose delivery, pickup or dine-in and try again.'],
  // Wire code is still `google_link_required` (other surfaces match on it), but the
  // rule is "prove who you are", and a verified email proves it just as well as
  // Google. Copy mirrors `checkout.loyalty.verifyRequired` in messages/en.json.
  ['google_link_required', 'To spend loyalty points, verify your email or link your Google account first — it keeps your points safe. You can still order without redeeming.'],
];

function describeOrderError(msg: string): string {
  for (const [code, text] of ORDER_ERRORS) {
    if (msg.includes(code)) return text;
  }
  return msg;
}

// place-order's r2, character for character. Every money expression below is a
// mirror of the server's, because the diner agrees to the number on this screen
// and the server charges its own — the two have to land on the same cent.
const r2 = (n: number) => Math.round(n * 100) / 100;

type DropoffPref = 'leave_at_door' | 'hand_to_me' | 'at_desk' | 'other';

const DROPOFF_OPTIONS: Array<{ value: DropoffPref; label: string }> = [
  { value: 'leave_at_door', label: 'Leave at the door' },
  { value: 'hand_to_me', label: 'Hand it to me' },
  { value: 'at_desk', label: 'At the desk / reception' },
  { value: 'other', label: 'Other' },
];

interface Props {
  branchId: string;
  /** Scopes customer-row writes — identity is per restaurant, not global. */
  restaurantId?: string;
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
}

export function CheckoutView({
  branchId,
  restaurantId,
  base,
  canDeliver = false,
  canUseCard = false,
  salesTaxRate = 0,
  serviceFeePercent = 0,
}: Props) {
  const t = useTranslations();
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();

  const subtotal = useCart((s) => s.subtotal());
  const lines = useCart((s) => s.lines);
  const notes = useCart((s) => s.notes);
  const clear = useCart((s) => s.clear);
  // null until the diner picks an order type. OrderTypeGate (mounted by the page)
  // covers checkout until they do, so the null window is never interactive.
  const channel = useCart((s) => s.channel);

  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [email, setEmail] = React.useState('');
  const [address, setAddress] = React.useState('');
  const [dineInTable, setDineInTable] = React.useState('');
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
  const [addressNotes, setAddressNotes] = React.useState('');
  const [dropoffPref, setDropoffPref] = React.useState<DropoffPref | null>(null);
  const [dropoffOther, setDropoffOther] = React.useState('');
  const [gateCode, setGateCode] = React.useState('');
  const [room, setRoom] = React.useState('');
  // The exact line1 Mapbox last resolved — guards against the autofill's own
  // input event clearing the coordinates immediately after onResolved sets them.
  const resolvedAddressRef = React.useRef<string | null>(null);
  const [method, setMethod] = React.useState<PaymentMethod>('card');
  // Seeded from the entitlement, not from PAYMENT_MATRIX_DEFAULTS: the branch
  // settings arrive a tick later, and for that tick an unentitled branch would
  // otherwise offer Card.
  const [paymentMatrix, setPaymentMatrix] = React.useState<PaymentMatrix>(() =>
    parsePaymentMatrix({}, canUseCard),
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
  const tableRef = React.useRef<HTMLInputElement | null>(null);
  const scheduleSectionRef = React.useRef<HTMLLabelElement | null>(null);
  const clearFieldError = (key: string) =>
    setFieldErrors((cur) => {
      if (!cur[key]) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });
  const [pointsBalance, setPointsBalance] = React.useState(0);
  const [redeemPoints, setRedeemPoints] = React.useState(0);
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
  const [scheduleMode, setScheduleMode] = React.useState<'asap' | 'later'>('asap');
  const [scheduledFor, setScheduledFor] = React.useState<string>(() => {
    // Default: 1 hour from now, rounded to next 15 min
    const d = new Date(Date.now() + 60 * 60_000);
    d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    // datetime-local needs local YYYY-MM-DDTHH:mm
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  });
  const [promoState, setPromoState] = React.useState<
    | { status: 'idle' }
    | { status: 'validating' }
    | { status: 'applied'; amount_off: number; free_delivery: boolean; promo_id: string }
    | { status: 'error'; message: string }
  >({ status: 'idle' });
  const [giftCardCode, setGiftCardCode] = React.useState('');
  const [giftCardState, setGiftCardState] = React.useState<
    | { status: 'idle' }
    | { status: 'checking' }
    | { status: 'valid'; balance: number }
    | { status: 'error'; message: string }
  >({ status: 'idle' });

  // Distance-based quote when the address has coordinates (server-authoritative —
  // place-order runs the same quote_delivery formula); legacy flat fee otherwise.
  const deliveryFeeBase = channel !== 'delivery' ? 0 : quote?.deliverable ? quote.fee : 3.99;
  const outOfRange =
    channel === 'delivery' && quote != null && !quote.deliverable && quote.reason === 'out_of_range';
  const deliveryFee = promoState.status === 'applied' && promoState.free_delivery ? 0 : deliveryFeeBase;
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
  const effectiveScheduleMode: 'asap' | 'later' = isDineIn ? 'asap' : scheduleMode;
  const paymentModeKey: PaymentMode = effectiveScheduleMode === 'later' ? 'scheduled' : 'asap';
  const enabledMethods = (['card', 'cash'] as const).filter((m) => paymentMatrix[paymentModeKey][m]);
  const asapPayable = paymentMatrix.asap.cash || paymentMatrix.asap.card;
  const scheduledPayable = paymentMatrix.scheduled.cash || paymentMatrix.scheduled.card;
  const serviceFee = r2(subtotal * (serviceFeePercent / 100));
  // Loyalty points are integer CENTS-off: 100 pts = $1. `subtotal` is dollars, so
  // the 50%-of-subtotal cap in points is `subtotal * 100 * 0.5` = `subtotal * 50`.
  // This is the identical expression place-order uses — the two must never drift,
  // or the diner agrees to a total the server does not charge.
  const maxRedeem = Math.min(pointsBalance, Math.floor(subtotal * 50));
  // Zero without a verified identity, so the summary total matches what the server
  // will actually charge instead of promising a discount it would reject.
  const appliedRedeem = identityVerified ? Math.min(redeemPoints, maxRedeem) : 0;
  // Points -> dollars. Every money-facing consumer reads THIS, never appliedRedeem.
  const loyaltyDollarsOff = r2(appliedRedeem / 100);
  // Slider positions: one per $1, then the cap itself as the last stop. With a
  // plain step=100 the browser clamps to the largest multiple of 100 under the
  // max, so a 499-pt cap could only ever reach 400 — $0.99 of the diner's own
  // points stranded behind a control whose label promises them.
  const redeemStops = Array.from({ length: Math.ceil(maxRedeem / 100) }, (_, i) => i * 100).concat(
    maxRedeem,
  );
  // Stops ascend and appliedRedeem is clamped to the last one, so this always hits.
  const redeemIndex = Math.max(0, redeemStops.findIndex((p) => p >= appliedRedeem));
  const tipAmount = customTip
    ? Math.max(0, Math.round((Number(customTip) || 0) * 100) / 100)
    : Math.round((subtotal * tipPercent)) / 100;
  // 0 is dropped: "No tip" is its own control now, so a legacy branch row that
  // still carries a 0 preset would otherwise render a duplicate of it.
  const tipPresets = tipPresetsForChannel(tipConfig, channel ?? 'pickup').filter((p) => p > 0);
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
    const { data, error } = await supabase.rpc('check_gift_card', { p_code: giftCardCode.trim() });
    if (error) {
      setGiftCardState({ status: 'error', message: error.message });
      return;
    }
    const r = data as { valid?: boolean; reason?: string; balance?: number };
    if (!r?.valid) {
      setGiftCardState({ status: 'error', message: r?.reason ?? 'invalid' });
      return;
    }
    setGiftCardState({ status: 'valid', balance: Number(r.balance ?? 0) });
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    void getMyLoyalty(supabase, branchId).then((row) => {
      if (row) setPointsBalance(row.points_balance);
    });
    void (async () => {
      const { data: user } = await supabase.auth.getUser();
      if (!user.user) return;
      const { data: customer } = await supabase
        .from('customers')
        .select('id, full_name, phone, email')
        .eq('user_id', user.user.id)
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!customer) return;
      setCustomerId(customer.id);
      if (customer.full_name) setName(customer.full_name);
      if (customer.phone) setPhone(customer.phone);
      if (customer.email) setEmail(customer.email);
      const addrs = await listCustomerAddresses(supabase, customer.id);
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

  // Tip presets + driver/house/staff split are configured per branch (jsonb
  // tip_config). place-order + the completion trigger record the authoritative
  // split on the server; this only drives the presets and the disclosure copy.
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
          setPaymentMatrix(parsePaymentMatrix(settings, canUseCard));
        }
      });
  }, [branchId, canUseCard]);

  // Keep the selected payment method valid for the current mode; when the
  // current mode has no methods at all, flip to the other mode (its toggle is
  // disabled below, so the user can't get back into the dead one).
  //
  // Dine-in opts out entirely: it has neither card on screen, and the flip would
  // turn a branch with no ASAP payment method into a silently SCHEDULED dine-in
  // order — held out of the kitchen, with a table number and nobody sitting at it.
  React.useEffect(() => {
    if (isDineIn) return;
    const modeKey: PaymentMode = scheduleMode === 'later' ? 'scheduled' : 'asap';
    const enabled = (['card', 'cash'] as const).filter((m) => paymentMatrix[modeKey][m]);
    if (enabled.length === 0) {
      const other: PaymentMode = modeKey === 'asap' ? 'scheduled' : 'asap';
      if (paymentMatrix[other].cash || paymentMatrix[other].card) {
        setScheduleMode(modeKey === 'asap' ? 'later' : 'asap');
      }
      return;
    }
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

  // Wait for Zustand persist rehydration before redirecting an "empty" cart —
  // otherwise we bounce away on first mount before localStorage loads.
  const [hydrated, setHydrated] = React.useState(false);
  React.useEffect(() => {
    const persist = useCart.persist;
    if (!persist || persist.hasHydrated()) {
      setHydrated(true);
      return;
    }
    const unsub = persist.onFinishHydration(() => setHydrated(true));
    void persist.rehydrate();
    return unsub;
  }, []);

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
        <h1 className="mt-4 font-display text-2xl font-bold">Please sign in to check out</h1>
        <p className="mt-1 text-muted-foreground">
          You need an account to place an order — it only takes a moment.
        </p>
        <Button
          variant="gradient"
          size="lg"
          className="mt-5"
          onClick={() =>
            router.replace(`${base}/sign-in?next=${encodeURIComponent(`${base}/checkout`)}`)
          }
        >
          Sign in to continue
        </Button>
      </div>
    );
  }
  if (lines.length === 0) {
    return (
      <div className="container max-w-2xl pt-12 text-center">
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-primary/10 text-primary">
          <ShoppingBag className="h-7 w-7" />
        </div>
        <h1 className="mt-4 font-display text-2xl font-bold">Your cart is empty</h1>
        <p className="mt-1 text-muted-foreground">Add a few items from the menu to check out.</p>
        <Button variant="gradient" size="lg" className="mt-5" onClick={() => router.push(base)}>
          Browse the menu
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
      setPromoState({ status: 'error', message: error.message });
      return;
    }
    const r = data as {
      valid: boolean;
      error?: string;
      amount_off?: number;
      free_delivery?: boolean;
      promo_id?: string;
    };
    if (!r.valid) {
      setPromoState({ status: 'error', message: r.error ?? 'invalid' });
      return;
    }
    setPromoState({
      status: 'applied',
      amount_off: Number(r.amount_off ?? 0),
      free_delivery: !!r.free_delivery,
      promo_id: r.promo_id ?? '',
    });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    // OrderTypeGate is covering the page — there is nothing to submit yet.
    if (!channel) return;

    // Validate every field up front, then focus the first problem.
    const errs: Record<string, string> = {};
    // 'later' with a cleared time would silently become ASAP server-side
    // (place-order derives the mode from scheduled_for) — and be gated
    // against the wrong payment matrix. Block it here. Dine-in never reaches
    // this: effectiveScheduleMode pins it to 'asap' and the card is hidden.
    if (effectiveScheduleMode === 'later' && !scheduledFor)
      errs.schedule = 'Please pick a time for your scheduled order.';
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
      if (!dropoffPref) errs.dropoff = 'Please choose where the driver should leave your order.';
      else if (dropoffPref === 'other' && !dropoffOther.trim())
        errs.dropoff = 'Please describe the drop-off spot.';
    }
    if (channel === 'dine_in' && !dineInTable.trim()) errs.table = t('checkout.errors.tableRequired');
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
                  : errs.table
                    ? tableRef.current
                    : null;
      firstEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (firstEl && firstEl instanceof HTMLInputElement) firstEl.focus({ preventScroll: true });
      return;
    }
    setFieldErrors({});

    if (outOfRange) {
      setError('This address is outside the delivery area.');
      return;
    }
    setSubmitting(true);
    try {
      const supabase = getBrowserClient();
      // Persist email on the customer row so receipts/notifications can reach
      // them — scoped to THIS restaurant. Customer identity is per restaurant;
      // an unscoped update would overwrite the email on every tenant's row.
      if (email.trim()) {
        const { data: user } = await supabase.auth.getUser();
        if (user.user) {
          let upd = supabase
            .from('customers')
            .update({ email: email.trim().toLowerCase() })
            .eq('user_id', user.user.id);
          if (restaurantId) upd = upd.eq('restaurant_id', restaurantId);
          await upd;
        }
      }

      const result = await placeOrder(supabase, {
        branch_id: branchId,
        channel,
        customer_name: name,
        customer_phone: phone,
        customer_notes:
          channel === 'dine_in' && dineInTable.trim()
            ? `Table ${dineInTable.trim()}${notes ? ` — ${notes}` : ''}`
            : notes || undefined,
        // Structured too, so place-order can resolve it to a real tables row and
        // the kitchen/floor plan stop relying on the notes prefix above.
        table_number: channel === 'dine_in' ? dineInTable.trim() : undefined,
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
        payment_method: isDineIn ? 'cash' : method,
        redeem_points: appliedRedeem || undefined,
        tip_amount: tipAmount || undefined,
        promo_code: promoState.status === 'applied' ? promoCode.trim() : undefined,
        // Belt and braces on top of effectiveScheduleMode — no state, however
        // stale, can smuggle a scheduled_for onto a dine-in order.
        scheduled_for:
          !isDineIn && effectiveScheduleMode === 'later' && scheduledFor
            ? new Date(scheduledFor).toISOString()
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
      });

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
      router.push(`${base}/orders/${result.order_number}`);
    } catch (err) {
      setError(describeOrderError((err as Error).message));
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
        {/* Dine-in is ASAP only — the diner is already sitting in the room. */}
        {!isDineIn && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">When?</h2>
            <div className="mt-3 flex rounded-full bg-muted p-1 text-sm font-semibold">
              <button
                type="button"
                disabled={!asapPayable}
                onClick={() => setScheduleMode('asap')}
                className={`focus-ring flex-1 rounded-full py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  scheduleMode === 'asap' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                ASAP
              </button>
              <button
                type="button"
                disabled={!scheduledPayable}
                onClick={() => setScheduleMode('later')}
                className={`focus-ring flex-1 rounded-full py-2 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                  scheduleMode === 'later' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
                }`}
              >
                Schedule for later
              </button>
            </div>
            {!scheduledPayable && (
              <p className="mt-2 text-xs text-muted-foreground">
                Scheduled orders are not available with the restaurant current payment options.
              </p>
            )}
            {!asapPayable && (
              <p className="mt-2 text-xs text-muted-foreground">
                ASAP orders are not available with the restaurant current payment options.
              </p>
            )}
            {scheduleMode === 'later' && (
              <label ref={scheduleSectionRef} className="mt-3 block">
                <span className="mb-1 block text-sm font-medium">Pickup / delivery time</span>
                <input
                  type="datetime-local"
                  value={scheduledFor}
                  min={new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 16)}
                  onChange={(e) => { setScheduledFor(e.target.value); clearFieldError('schedule'); }}
                  aria-invalid={!!fieldErrors.schedule}
                  className="input"
                  style={fieldErrors.schedule ? { borderColor: 'hsl(var(--danger))' } : undefined}
                />
                {fieldErrors.schedule && (
                  <p className="mt-1 text-xs text-danger">{fieldErrors.schedule}</p>
                )}
                <p className="mt-1 text-xs text-muted-foreground">
                  We&apos;ll start preparing your order so it&apos;s ready right around this time.
                </p>
              </label>
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
                        {a.label ?? 'Address'}
                        {a.is_default && <Badge variant="muted">Default</Badge>}
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
                  + Use a new address
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
                    <MapPin className="h-3.5 w-3.5" /> Location pinned
                  </p>
                )}
              </div>
            )}
            {quoting && (
              <p className="mt-2 text-xs text-muted-foreground">Calculating delivery…</p>
            )}
            {!quoting && quote?.deliverable && (
              <p className="mt-2 text-xs text-muted-foreground">
                {kmToMi(quote.distance_km).toFixed(1)} mi away · delivery {formatCurrency(quote.fee)} · ready in ~
                {quote.eta_min} min
              </p>
            )}
            {outOfRange && (
              <p className="mt-2 text-sm font-medium text-danger">
                Sorry, this address is outside the delivery area
                {!quote.deliverable && quote.radius_km ? ` (max ${kmToMi(quote.radius_km).toFixed(1)} mi)` : ''}.
              </p>
            )}
            {enteringNewAddress && !addressCoords && !quoting && address.trim().length > 3 && (
              <p className="mt-2 text-xs font-medium text-warning">
                Select your address from the suggestions to confirm delivery and see the exact fee.
              </p>
            )}

            <div className="mt-4" ref={dropoffSectionRef}>
              <label className="mb-1 block text-sm font-medium">Where should we leave it?</label>
              <div className="grid grid-cols-2 gap-2">
                {DROPOFF_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => { setDropoffPref(opt.value); clearFieldError('dropoff'); }}
                    aria-pressed={dropoffPref === opt.value}
                    className={`rounded-xl border px-3 py-2 text-sm font-medium transition ${
                      dropoffPref === opt.value
                        ? 'border-primary bg-primary/10 text-primary'
                        : 'border-border bg-card'
                    }`}
                    style={
                      fieldErrors.dropoff && !dropoffPref
                        ? { borderColor: 'hsl(var(--danger))' }
                        : undefined
                    }
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              {dropoffPref === 'other' && (
                <input
                  value={dropoffOther}
                  onChange={(e) => { setDropoffOther(e.target.value); clearFieldError('dropoff'); }}
                  placeholder="Tell the driver where to leave it"
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
                    Front gate code <span className="font-normal text-muted-foreground">(optional)</span>
                  </span>
                  <input
                    value={gateCode}
                    onChange={(e) => setGateCode(e.target.value)}
                    maxLength={40}
                    placeholder="e.g. #1234"
                    className="input"
                  />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-medium">
                    Room / unit <span className="font-normal text-muted-foreground">(optional)</span>
                  </span>
                  <input
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                    maxLength={40}
                    placeholder="e.g. Apt 203"
                    className="input"
                  />
                </label>
              </div>
            </div>

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium">
                Delivery instructions <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <textarea
                value={addressNotes}
                onChange={(e) => setAddressNotes(e.target.value)}
                placeholder="e.g. Blue house behind the bakery · call on arrival"
                rows={2}
                maxLength={300}
                className="focus-ring w-full resize-none rounded-2xl border border-border bg-background px-4 py-3 text-base placeholder:text-muted-foreground"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                Anything that helps the driver find you — useful when the map isn&apos;t exact.
              </p>
            </div>
          </Card>
        )}

        {channel === 'dine_in' && (
          <Card className="p-5">
            <h2 className="font-display text-lg font-semibold">
              Dine-in <span className="text-danger">*</span>
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Your table number is required so we can bring your food over.
            </p>
            <input
              ref={tableRef}
              value={dineInTable}
              onChange={(e) => { setDineInTable(e.target.value); clearFieldError('table'); }}
              placeholder="Table number"
              inputMode="numeric"
              // aria only: the form runs its own validation in handleSubmit and
              // native `required` would pre-empt it with a browser tooltip.
              aria-required="true"
              aria-invalid={!!fieldErrors.table}
              className="input mt-3"
              style={fieldErrors.table ? { borderColor: 'hsl(var(--danger))' } : undefined}
            />
            {fieldErrors.table && <p className="mt-1 text-xs text-danger">{fieldErrors.table}</p>}
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
            </div>
            {enabledMethods.length === 0 && (
              <p className="mt-3 text-sm text-muted-foreground">
                This restaurant has no payment options available right now.
              </p>
            )}
          </Card>
        )}

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold flex items-center gap-2">
            <Tag className="h-4 w-4" /> Promo code
          </h2>
          {promoState.status === 'applied' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl bg-success/10 px-3 py-2">
              <span className="text-sm text-success font-medium">
                {promoCode} — saved {formatCurrency(promoState.amount_off)}{promoState.free_delivery ? ' + free delivery' : ''}
              </span>
              <button
                type="button"
                onClick={() => { setPromoCode(''); setPromoState({ status: 'idle' }); }}
                className="text-xs text-muted-foreground underline"
              >
                Remove
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
                Apply
              </Button>
            </div>
          )}
          {promoState.status === 'error' && (
            <p className="mt-2 text-xs text-destructive">{promoState.message}</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            🎁 Gift card
          </h2>
          {giftCardState.status === 'valid' ? (
            <div className="mt-3 flex items-center justify-between rounded-xl bg-success/10 px-3 py-2">
              <span className="text-sm font-medium text-success">
                {giftCardCode} — applies {formatCurrency(giftCardCredit)} (balance {formatCurrency(giftCardState.balance)})
              </span>
              <button
                type="button"
                onClick={() => { setGiftCardCode(''); setGiftCardState({ status: 'idle' }); }}
                className="text-xs text-muted-foreground underline"
              >
                Remove
              </button>
            </div>
          ) : (
            <div className="mt-3 flex gap-2">
              <input
                value={giftCardCode}
                onChange={(e) => setGiftCardCode(e.target.value.toUpperCase())}
                placeholder="Gift card code"
                className="input flex-1"
              />
              <Button type="button" variant="ghost" onClick={checkGiftCard} loading={giftCardState.status === 'checking'}>
                Apply
              </Button>
            </div>
          )}
          {giftCardState.status === 'error' && (
            <p className="mt-2 text-xs text-destructive">{giftCardState.message}</p>
          )}
        </Card>

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">Add a tip</h2>
          <p className="text-xs text-muted-foreground">
            {tipWorkerPct}% goes to your {channel === 'delivery' ? 'driver' : 'kitchen & staff team'}
            {tipWorkerPct < 100 ? ' (the rest supports the restaurant).' : '.'}
          </p>
          {/* Three columns on a 360px phone, one row from sm up — five chips
              across a phone leaves "Custom" too narrow to read. */}
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {tipPresets.map((p) => {
              const active = !tipCustom && !customTip && tipPercent === p;
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={active}
                  // Tapping the selected chip again clears it — the only way back
                  // to "no tip" without hunting for another control.
                  onClick={() => {
                    setTipCustom(false);
                    setCustomTip('');
                    setTipPercent(active ? 0 : p);
                  }}
                  className={`focus-ring rounded-xl border px-2 py-2 text-sm font-medium transition ${
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
              onClick={() => { setTipCustom(true); setTipPercent(0); }}
              className={`focus-ring rounded-xl border px-2 py-2 text-sm font-medium transition ${
                tipCustom ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
              }`}
            >
              Custom
            </button>
          </div>
          {tipCustom && (
            <input
              value={customTip}
              onChange={(e) => setCustomTip(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="Custom amount in USD"
              inputMode="decimal"
              aria-label="Custom tip amount in USD"
              className="input mt-2"
            />
          )}
          <button
            type="button"
            aria-pressed={noTipSelected}
            onClick={() => { setTipCustom(false); setTipPercent(0); setCustomTip(''); }}
            className={`focus-ring mt-2 w-full rounded-xl border px-3 py-2 text-sm font-medium transition ${
              noTipSelected ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
            }`}
          >
            No tip
          </button>
        </Card>

        {pointsBalance > 0 && maxRedeem > 0 && (
          <Card className="p-5">
            <div className="flex items-baseline justify-between">
              <h2 className="font-display text-lg font-semibold">Loyalty points</h2>
              <span className="text-sm text-muted-foreground">
                Balance: <strong>{pointsBalance.toLocaleString()}</strong>
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Redeem up to {maxRedeem.toLocaleString()} pts (50% of subtotal) — 100 pts = $1 off.
            </p>
            <div className="mt-3 flex items-center gap-3">
              <input
                type="range"
                // The slider rides the INDEX of redeemStops, not the points
                // themselves: one detent per $1 (a 1-pt step would be thousands
                // of drags wide) while the far right still lands exactly on the
                // cap the copy above quotes. Every stop is an integer <= the cap,
                // so the control can never emit more than the server allows.
                // aria-valuetext below speaks the points, not the index.
                min={0}
                max={redeemStops.length - 1}
                step={1}
                value={redeemIndex}
                disabled={!identityVerified}
                onChange={(e) => setRedeemPoints(redeemStops[Number(e.target.value)] ?? 0)}
                className="h-2 flex-1 accent-primary disabled:opacity-40"
                aria-label="Redeem points"
                aria-valuetext={`${appliedRedeem.toLocaleString()} points, ${formatCurrency(loyaltyDollarsOff)} off`}
              />
              <span className="w-20 text-right font-display text-base font-bold text-primary tabular-nums">
                -{formatCurrency(loyaltyDollarsOff)}
              </span>
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
            <Row
              label={t('cart.deliveryFee')}
              value={
                channel === 'delivery' && quoting
                  ? 'Calculating…'
                  : channel === 'delivery' && enteringNewAddress && !addressCoords
                    ? '—'
                    : formatCurrency(deliveryFee)
              }
            />
            <Row label={t('cart.serviceFee')} value={formatCurrency(serviceFee)} />
            {/* Only where the branch actually charges it — a tax-free branch
                showing a $0.00 tax line is noise. Same label as the receipt. */}
            {salesTaxRate > 0 && <Row label="Sales tax" value={formatCurrency(taxAmount)} />}
            {tipAmount > 0 && <Row label="Tip" value={formatCurrency(tipAmount)} />}
            {promoDiscount > 0 && <Row label={`Promo (${promoCode})`} value={`-${formatCurrency(promoDiscount)}`} />}
            {appliedRedeem > 0 && (
              <Row label="Loyalty discount" value={`-${formatCurrency(loyaltyDollarsOff)}`} />
            )}
            <div className="my-2 h-px bg-border" />
            <Row label={t('cart.total')} value={formatCurrency(total)} bold />
          </dl>
        </Card>

        {error && (
          <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">
            <strong>Couldn&apos;t place order:</strong> {error}
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
              // Dine-in doesn't pay online, so an all-off ASAP matrix must not
              // disable it — the card that explains why is hidden for dine-in,
              // and a dead button with no reason is worse than no button.
              (!isDineIn && enabledMethods.length === 0) ||
              (channel === 'delivery' && quoting) ||
              (channel === 'delivery' && enteringNewAddress && !addressCoords)
            }
          >
            {t('checkout.placeOrder', { amount: formatCurrency(total) })}
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
