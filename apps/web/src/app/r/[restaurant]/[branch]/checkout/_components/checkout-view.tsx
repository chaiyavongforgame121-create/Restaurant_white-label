'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Banknote, ChevronLeft, CreditCard, LocateFixed, Map as MapIcon, MapPin, ShoppingBag, Tag } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { formatCurrency } from '@favornoms/shared';
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

type PaymentMethod = 'card' | 'cash';

interface Props {
  branchId: string;
  base: string;
}

export function CheckoutView({ branchId, base }: Props) {
  const t = useTranslations();
  const router = useRouter();

  const subtotal = useCart((s) => s.subtotal());
  const lines = useCart((s) => s.lines);
  const notes = useCart((s) => s.notes);
  const clear = useCart((s) => s.clear);
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
  // The exact line1 Mapbox last resolved — guards against the autofill's own
  // input event clearing the coordinates immediately after onResolved sets them.
  const resolvedAddressRef = React.useRef<string | null>(null);
  const [method, setMethod] = React.useState<PaymentMethod>('card');
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
  const tableRef = React.useRef<HTMLInputElement | null>(null);
  const clearFieldError = (key: string) =>
    setFieldErrors((cur) => {
      if (!cur[key]) return cur;
      const next = { ...cur };
      delete next[key];
      return next;
    });
  const [pointsBalance, setPointsBalance] = React.useState(0);
  const [redeemPoints, setRedeemPoints] = React.useState(0);
  const [tipPercent, setTipPercent] = React.useState<0 | 5 | 10 | 15>(0);
  const [customTip, setCustomTip] = React.useState('');
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
  const serviceFee = Math.round(subtotal * 0.05 * 100) / 100;
  const maxRedeem = Math.min(pointsBalance, Math.floor(subtotal * 0.5));
  const appliedRedeem = Math.min(redeemPoints, maxRedeem);
  const tipAmount = customTip
    ? Math.max(0, Math.round((Number(customTip) || 0) * 100) / 100)
    : Math.round((subtotal * tipPercent)) / 100;
  const promoDiscount = promoState.status === 'applied' ? promoState.amount_off : 0;
  const giftCardCredit = giftCardState.status === 'valid' ? Math.min(giftCardState.balance, subtotal) : 0;
  const total = Math.max(
    0,
    subtotal + deliveryFee + serviceFee + tipAmount - appliedRedeem - promoDiscount - giftCardCredit,
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

  if (!hydrated) return null;
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

    // Validate every field up front, then focus the first problem.
    const errs: Record<string, string> = {};
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
    }
    if (channel === 'dine_in' && !dineInTable.trim()) errs.table = t('checkout.errors.tableRequired');
    if (Object.keys(errs).length > 0) {
      setFieldErrors(errs);
      const firstEl = errs.name
        ? nameRef.current
        : errs.phone
          ? phoneRef.current
          : errs.email
            ? emailRef.current
            : errs.address
              ? addressSectionRef.current
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
      // Persist email on the customer row so receipts/notifications can reach them.
      if (email.trim()) {
        const { data: user } = await supabase.auth.getUser();
        if (user.user) {
          await supabase
            .from('customers')
            .update({ email: email.trim().toLowerCase() })
            .eq('user_id', user.user.id);
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
        delivery_address:
          channel === 'delivery'
            ? {
                line1: address,
                line2: addressMeta?.line2,
                city: addressMeta?.city,
                state: addressMeta?.state,
                postal_code: addressMeta?.postal_code,
                notes: addressNotes.trim() || undefined,
                lat: addressCoords?.lat,
                lng: addressCoords?.lng,
              }
            : undefined,
        saved_address_id:
          selectedAddressId && selectedAddressId !== 'new' ? selectedAddressId : undefined,
        payment_method: method,
        redeem_points: appliedRedeem || undefined,
        tip_amount: tipAmount || undefined,
        promo_code: promoState.status === 'applied' ? promoCode.trim() : undefined,
        scheduled_for:
          scheduleMode === 'later' && scheduledFor
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
      const msg = (err as Error).message;
      setError(
        msg.includes('branch_closed')
          ? 'This restaurant is currently closed. Please try again during opening hours.'
          : msg.includes('delivery_out_of_range')
            ? 'Sorry, this address is outside the delivery area.'
            : msg,
      );
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
        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">When?</h2>
          <div className="mt-3 flex rounded-full bg-muted p-1 text-sm font-semibold">
            <button
              type="button"
              onClick={() => setScheduleMode('asap')}
              className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
                scheduleMode === 'asap' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
              }`}
            >
              ASAP
            </button>
            <button
              type="button"
              onClick={() => setScheduleMode('later')}
              className={`focus-ring flex-1 rounded-full py-2 transition-colors ${
                scheduleMode === 'later' ? 'bg-card text-foreground shadow-soft' : 'text-muted-foreground'
              }`}
            >
              Schedule for later
            </button>
          </div>
          {scheduleMode === 'later' && (
            <label className="mt-3 block">
              <span className="mb-1 block text-sm font-medium">Pickup / delivery time</span>
              <input
                type="datetime-local"
                value={scheduledFor}
                min={new Date(Date.now() + 15 * 60_000).toISOString().slice(0, 16)}
                onChange={(e) => setScheduledFor(e.target.value)}
                className="input"
              />
              <p className="mt-1 text-xs text-muted-foreground">
                We&apos;ll start preparing your order so it&apos;s ready right around this time.
              </p>
            </label>
          )}
        </Card>

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
                {quote.distance_km.toFixed(1)} km away · delivery {formatCurrency(quote.fee)} · ready in ~
                {quote.eta_min} min
              </p>
            )}
            {outOfRange && (
              <p className="mt-2 text-sm font-medium text-danger">
                Sorry, this address is outside the delivery area
                {!quote.deliverable && quote.radius_km ? ` (max ${quote.radius_km} km)` : ''}.
              </p>
            )}
            {enteringNewAddress && !addressCoords && !quoting && address.trim().length > 3 && (
              <p className="mt-2 text-xs font-medium text-warning">
                Select your address from the suggestions to confirm delivery and see the exact fee.
              </p>
            )}

            <div className="mt-4">
              <label className="mb-1 block text-sm font-medium">
                Delivery instructions <span className="font-normal text-muted-foreground">(optional)</span>
              </label>
              <textarea
                value={addressNotes}
                onChange={(e) => setAddressNotes(e.target.value)}
                placeholder="e.g. Front gate code 1234 · Room 203 · leave at the door"
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
            <h2 className="font-display text-lg font-semibold">Dine-in</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Enter your table number so we can bring your food over.
            </p>
            <input
              ref={tableRef}
              value={dineInTable}
              onChange={(e) => { setDineInTable(e.target.value); clearFieldError('table'); }}
              placeholder="Table number"
              inputMode="numeric"
              aria-invalid={!!fieldErrors.table}
              className="input mt-3"
              style={fieldErrors.table ? { borderColor: 'hsl(var(--danger))' } : undefined}
            />
            {fieldErrors.table && <p className="mt-1 text-xs text-danger">{fieldErrors.table}</p>}
          </Card>
        )}

        <Card className="p-5">
          <h2 className="font-display text-lg font-semibold">{t('checkout.paymentMethod')}</h2>
          <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
            <PaymentChoice icon={<CreditCard className="h-5 w-5" />} label={t('checkout.payment.card')} active={method === 'card'} onClick={() => setMethod('card')} />
            <PaymentChoice icon={<Banknote className="h-5 w-5" />} label={t('checkout.payment.cash')} active={method === 'cash'} onClick={() => setMethod('cash')} />
          </div>
        </Card>

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
          <p className="text-xs text-muted-foreground">100% goes to your driver / kitchen team.</p>
          <div className="mt-3 grid grid-cols-4 gap-2">
            {([0, 5, 10, 15] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => { setTipPercent(p); setCustomTip(''); }}
                className={`rounded-xl border px-3 py-2 text-sm font-medium ${
                  tipPercent === p && !customTip
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border bg-card'
                }`}
              >
                {p === 0 ? 'None' : `${p}%`}
              </button>
            ))}
          </div>
          <input
            value={customTip}
            onChange={(e) => { setCustomTip(e.target.value.replace(/[^0-9.]/g, '')); setTipPercent(0); }}
            placeholder="Custom amount in USD"
            inputMode="decimal"
            className="input mt-3"
          />
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
                min={0}
                max={maxRedeem}
                step={10}
                value={appliedRedeem}
                onChange={(e) => setRedeemPoints(Number(e.target.value))}
                className="h-2 flex-1 accent-primary"
                aria-label="Redeem points"
              />
              <span className="w-20 text-right font-display text-base font-bold text-primary tabular-nums">
                -{formatCurrency(appliedRedeem / 100)}
              </span>
            </div>
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
            {tipAmount > 0 && <Row label="Tip" value={formatCurrency(tipAmount)} />}
            {promoDiscount > 0 && <Row label={`Promo (${promoCode})`} value={`-${formatCurrency(promoDiscount)}`} />}
            {appliedRedeem > 0 && <Row label="Loyalty discount" value={`-${formatCurrency(appliedRedeem)}`} />}
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
              outOfRange ||
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
