'use client';

import * as React from 'react';
import dynamic from 'next/dynamic';
import { useLocale, useTranslations } from 'next-intl';
import { MapPin, X } from 'lucide-react';
import { DEFAULT_UI_LOCALE, formatCurrency, isUiLocale } from '@favornoms/shared';
import { hasMapboxToken, kmToMiles, type ResolvedAddress } from '@favornoms/maps';
import { getBrowserClient } from '@favornoms/database/client';
import { Sheet } from '@favornoms/ui';

// The storefront checkout's picker. Behind a button most sales never press, so it is only
// downloaded when someone opens it.
const LocationPicker = dynamic(
  () => import('@favornoms/maps').then((m) => m.LocationPicker),
  { ssr: false },
);

export interface CounterDelivery {
  /** Street address, as the rider will read it. */
  line1: string;
  /** Gate, floor, landmark. */
  notes: string;
  /** Where the map pin was dropped, or null for none. */
  pin: { lat: number; lng: number } | null;
}

export const EMPTY_DELIVERY: CounterDelivery = { line1: '', notes: '', pin: null };

export type DeliveryQuoteState =
  | { status: 'none' }
  | { status: 'loading' }
  | { status: 'ok'; fee: number; distanceKm: number | null; etaMin: number | null }
  | { status: 'out_of_range'; distanceKm: number | null; radiusKm: number | null }
  | { status: 'not_entitled' }
  /** quote_delivery could not price it (no branch location, odd coordinates, a failed call):
   *  place-order charges the flat fee in that case, and so does the till. */
  | { status: 'flat' };

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * The fee for a pinned address, from the same quote_delivery place-order runs. No pin, no quote:
 * place-order then charges the branch's flat fee, and the till shows that instead.
 */
export function useDeliveryQuote(branchId: string, pin: CounterDelivery['pin'], active: boolean) {
  const [state, setState] = React.useState<DeliveryQuoteState>({ status: 'none' });
  const lat = pin?.lat ?? null;
  const lng = pin?.lng ?? null;

  React.useEffect(() => {
    if (!active || lat == null || lng == null) {
      setState({ status: 'none' });
      return undefined;
    }
    let cancelled = false;
    setState({ status: 'loading' });
    void (async () => {
      try {
        const { data, error } = await getBrowserClient().rpc('quote_delivery', {
          p_branch_id: branchId,
          p_lat: lat,
          p_lng: lng,
        });
        if (cancelled) return;
        const q = (error ? null : data) as Record<string, unknown> | null;
        if (q?.deliverable === true) {
          setState({
            status: 'ok',
            fee: Number(q.fee ?? 0),
            distanceKm: num(q.distance_km),
            etaMin: num(q.eta_min),
          });
        } else if (q?.reason === 'out_of_range') {
          setState({ status: 'out_of_range', distanceKm: num(q.distance_km), radiusKm: num(q.radius_km) });
        } else if (q?.reason === 'delivery_not_entitled') {
          setState({ status: 'not_entitled' });
        } else {
          setState({ status: 'flat' });
        }
      } catch {
        if (!cancelled) setState({ status: 'flat' });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [branchId, lat, lng, active]);

  return state;
}

/** Delivery hours are checked on the minute; the trigger that enforces them uses the same test. */
const HOURS_POLL_MS = 60_000;

/**
 * Whether the branch delivers right now, from the is_delivery_available the orders insert trigger
 * runs. A delivery outside the hours was only refused at Charge -- and for a QR sale, after the
 * customer had already transferred. A failed check says nothing ('unknown'): place-order still
 * has the last word, and a flaky call must not stop the till.
 */
export function useDeliveryHours(branchId: string, active: boolean) {
  const [status, setStatus] = React.useState<'unknown' | 'open' | 'closed'>('unknown');

  const recheck = React.useCallback(async () => {
    try {
      const { data, error } = await getBrowserClient().rpc('is_delivery_available', {
        p_branch_id: branchId,
      });
      setStatus(error || typeof data !== 'boolean' ? 'unknown' : data ? 'open' : 'closed');
    } catch {
      setStatus('unknown');
    }
  }, [branchId]);

  React.useEffect(() => {
    if (!active) {
      setStatus('unknown');
      return undefined;
    }
    void recheck();
    const id = window.setInterval(() => {
      if (document.visibilityState === 'visible') void recheck();
    }, HOURS_POLL_MS);
    return () => window.clearInterval(id);
  }, [active, recheck]);

  return { status, recheck };
}

function formatResolved(a: ResolvedAddress): string {
  const tail = [a.state, a.postal_code].filter(Boolean).join(' ');
  return [a.line1, a.line2, a.city, tail].filter(Boolean).join(', ');
}

/**
 * Where a delivery rung up at the till is going.
 *
 * The till had no address field at all, so place-order refused every counter delivery with
 * delivery_address_required and the screen called it "refused" -- the owner's "error when paying
 * at the counter". The phone is asked for by the cart (it doubles as the points lookup), the rest
 * is here: the address the rider reads, notes, and optionally a pin, which is what gets the
 * delivery a distance-based fee and the rider a point on the map.
 */
export function CounterDeliveryFields({
  value,
  onChange,
  quote,
  flatFee,
  branchCenter,
  showErrors,
}: {
  value: CounterDelivery;
  onChange: (next: CounterDelivery) => void;
  quote: DeliveryQuoteState;
  flatFee: number;
  branchCenter: { lat: number; lng: number } | null;
  showErrors: boolean;
}) {
  const t = useTranslations('counter');
  const rawLocale = useLocale();
  const locale = isUiLocale(rawLocale) ? rawLocale : DEFAULT_UI_LOCALE;
  const [pickerOpen, setPickerOpen] = React.useState(false);
  // Read on the client only: the token is a public env var, but the server render must not
  // decide it differently from the browser.
  const [canPin, setCanPin] = React.useState(false);
  React.useEffect(() => setCanPin(hasMapboxToken()), []);

  const missingLine = showErrors && !value.line1.trim();

  return (
    <div className="space-y-2">
      <label className="block">
        <span className="text-muted-foreground mb-1.5 block text-xs font-semibold uppercase tracking-wider">
          {t('delivery.address')}
        </span>
        <div className="flex gap-2">
          <input
            value={value.line1}
            onChange={(e) => onChange({ ...value, line1: e.target.value.slice(0, 200) })}
            placeholder={t('delivery.addressPlaceholder')}
            aria-invalid={missingLine || undefined}
            autoComplete="off"
            className={`focus-ring bg-card h-10 w-full min-w-0 rounded-xl border px-3 text-base ${
              missingLine ? 'border-danger' : 'border-border'
            }`}
          />
          {canPin && (
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              aria-label={value.pin ? t('delivery.movePin') : t('delivery.dropPin')}
              title={value.pin ? t('delivery.movePin') : t('delivery.dropPin')}
              className={`focus-ring grid h-10 w-10 shrink-0 place-items-center rounded-xl border ${
                value.pin ? 'border-primary bg-primary/10 text-primary' : 'border-border bg-card'
              }`}
            >
              <MapPin className="h-4 w-4" />
            </button>
          )}
        </div>
        {missingLine && <span className="text-danger mt-1 block text-xs">{t('delivery.addressRequired')}</span>}
      </label>
      <input
        value={value.notes}
        onChange={(e) => onChange({ ...value, notes: e.target.value.slice(0, 300) })}
        placeholder={t('delivery.notesPlaceholder')}
        aria-label={t('delivery.notes')}
        className="focus-ring border-border bg-card h-10 w-full rounded-xl border px-3 text-base"
      />

      <DeliveryFeeLine
        quote={quote}
        flatFee={flatFee}
        pinned={!!value.pin}
        onClearPin={() => onChange({ ...value, pin: null })}
      />

      <Sheet
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        side="bottom"
        title={t('delivery.pickerTitle')}
      >
        {pickerOpen && (
          <LocationPicker
            className="h-[70vh]"
            initial={value.pin}
            fallbackCenter={branchCenter}
            locale={locale}
            onConfirm={(a) => {
              onChange({
                ...value,
                pin: { lat: a.lat, lng: a.lng },
                // The cashier's own words win; the map only fills an empty line.
                line1: value.line1.trim() ? value.line1 : formatResolved(a).slice(0, 200),
              });
              setPickerOpen(false);
            }}
          />
        )}
      </Sheet>
    </div>
  );
}

function DeliveryFeeLine({
  quote,
  flatFee,
  pinned,
  onClearPin,
}: {
  quote: DeliveryQuoteState;
  flatFee: number;
  pinned: boolean;
  onClearPin: () => void;
}) {
  const t = useTranslations('counter');
  let body: React.ReactNode;
  let tone = 'text-muted-foreground';
  switch (quote.status) {
    case 'loading':
      body = t('delivery.quoting');
      break;
    case 'ok':
      body =
        quote.distanceKm != null
          ? t('delivery.quoted', {
              fee: formatCurrency(quote.fee),
              distance: kmToMiles(quote.distanceKm).toFixed(1),
              eta: quote.etaMin ?? 0,
            })
          : t('delivery.quotedNoDistance', { fee: formatCurrency(quote.fee) });
      break;
    case 'out_of_range':
      tone = 'text-danger';
      body =
        quote.radiusKm != null
          ? t('delivery.outOfRangeMax', { max: kmToMiles(quote.radiusKm).toFixed(1) })
          : t('delivery.outOfRange');
      break;
    case 'not_entitled':
      tone = 'text-danger';
      body = t('delivery.notSold');
      break;
    default:
      body = t('delivery.flatFee', { fee: formatCurrency(flatFee) });
  }
  return (
    <div className={`flex items-start justify-between gap-2 text-xs ${tone}`}>
      <p aria-live="polite">{body}</p>
      {pinned && (
        <button
          type="button"
          onClick={onClearPin}
          className="focus-ring text-muted-foreground hover:bg-muted inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5"
        >
          <X className="h-3 w-3" /> {t('delivery.clearPin')}
        </button>
      )}
    </div>
  );
}
