// Per-branch delivery configuration, stored in branches.settings (jsonb).
// The SQL function public.quote_delivery() mirrors these defaults and formulas —
// keep both sides in sync (see supabase migration `delivery_quote_backbone`).

export interface DeliverySettings {
  /** Base fee added to every delivery (USD). */
  deliveryBaseFee: number;
  /** Per-kilometer fee on top of the base (USD/km). */
  deliveryPerKmFee: number;
  /** Max straight-line delivery radius from the branch (km). */
  deliveryRadiusKm: number;
  /** Kitchen prep time baseline (minutes). */
  prepTimeMin: number;
  /** Extra prep buffer while "busy mode" is on (minutes). */
  busyExtraPrepMin: number;
  /** Manual surge multiplier (1 = off). */
  deliverySurgeMultiplier: number;
  /** Distance from the branch at which the surge multiplier starts applying (km).
   *  0 applies it to every order, which is what it did before this existed. */
  deliverySurgeFromKm: number;
  /** Seconds a dispatch offer stays valid before re-offer. */
  offerTtlSeconds: number;
  /** Driver pay: flat per delivery (USD). */
  driverBasePay: number;
  /** Driver pay: per trip kilometer (USD/km). */
  driverPerKmPay: number;
  /** Legacy flat fee fallback used when an order has no coordinates. */
  legacyFlatFee: number;
}

// US market presents distance in MILES. Internal math + storage stay metric (km)
// so the SQL quote_delivery()/find_dispatch_candidates formulas don't change — the
// admin UI converts on the way in/out, and customer/driver screens convert on
// display. A per-km value that equals an admin's per-mile input is stored by
// dividing by KM_PER_MILE (so base + perKm×distanceKm == base + perMile×distanceMi).
export const KM_PER_MILE = 1.609344;
/** km → miles (for display). */
export const kmToMi = (km: number): number => km / KM_PER_MILE;
/** miles → km (for storage and the server-side fee/ETA formulas). */
export const miToKm = (mi: number): number => mi * KM_PER_MILE;

// Defaults are stored in km / $-per-km but chosen to read as round MILES in the
// admin UI: 5 mi radius, $2.00/mi customer fee, $1.00/mi driver pay. quote_delivery()
// in SQL mirrors the per-km / radius numbers — keep both sides in sync.
export const DELIVERY_SETTING_DEFAULTS: DeliverySettings = {
  deliveryBaseFee: 2.49,
  deliveryPerKmFee: 2 / KM_PER_MILE, // $2.00 / mile
  deliveryRadiusKm: 5 * KM_PER_MILE, // 5 miles
  prepTimeMin: 15,
  busyExtraPrepMin: 0,
  deliverySurgeMultiplier: 1,
  deliverySurgeFromKm: 0,
  offerTtlSeconds: 75,
  driverBasePay: 2.0,
  driverPerKmPay: 1 / KM_PER_MILE, // $1.00 / mile
  legacyFlatFee: 3.99,
};

/** Average city driving speed used for the heuristic ETA (km/h). */
export const CITY_SPEED_KMH = 24;

function num(v: unknown, fallback: number): number {
  const n = typeof v === 'string' ? Number(v) : (v as number);
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}

/** Parse branches.settings jsonb into typed delivery settings with defaults. */
export function parseDeliverySettings(settings: Record<string, unknown> | null | undefined): DeliverySettings {
  const s = settings ?? {};
  const d = DELIVERY_SETTING_DEFAULTS;
  return {
    deliveryBaseFee: num(s.delivery_base_fee, d.deliveryBaseFee),
    deliveryPerKmFee: num(s.delivery_per_km_fee, d.deliveryPerKmFee),
    deliveryRadiusKm: num(s.delivery_radius_km, d.deliveryRadiusKm),
    prepTimeMin: num(s.prep_time_min, d.prepTimeMin),
    busyExtraPrepMin: num(s.busy_extra_prep_min, d.busyExtraPrepMin),
    deliverySurgeMultiplier: Math.max(1, num(s.delivery_surge_multiplier, d.deliverySurgeMultiplier)),
    // Set in MILES by the admin (that is the unit on screen); kept metric here so the rest
    // of this module and quote_delivery() stay in the same units.
    deliverySurgeFromKm: Math.max(0, miToKm(num(s.delivery_surge_from_mi, 0))),
    offerTtlSeconds: num(s.offer_ttl_seconds, d.offerTtlSeconds),
    driverBasePay: num(s.driver_base_pay, d.driverBasePay),
    driverPerKmPay: num(s.driver_per_km_pay, d.driverPerKmPay),
    legacyFlatFee: num(s.delivery_fee, d.legacyFlatFee),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** clamp(base + km×perKm, min, max) × surge — identical to quote_delivery() in SQL. */
/**
 * Mirrors SQL quote_delivery(). The two must land on the same cent — the merchant is shown
 * this number and the server charges its own.
 *
 * The min/max clamp is gone: the owner removed both inputs (2026-08-31) and quote_delivery
 * stopped clamping with them, so keeping a floor and a $9.99 ceiling here would have made
 * the preview disagree with every real order.
 */
export function computeDeliveryFee(settings: DeliverySettings, distanceKm: number): number {
  const fee = Math.max(0, settings.deliveryBaseFee + distanceKm * settings.deliveryPerKmFee);
  // Surge starts at a distance now, so a short hop is not multiplied.
  const surge = distanceKm < settings.deliverySurgeFromKm ? 1 : settings.deliverySurgeMultiplier;
  return round2(fee * surge);
}

/** prep + busy buffer + travel at CITY_SPEED_KMH — identical to quote_delivery() in SQL. */
export function heuristicEtaMin(settings: DeliverySettings, distanceKm: number): number {
  return settings.prepTimeMin + settings.busyExtraPrepMin + Math.ceil((distanceKm / CITY_SPEED_KMH) * 60);
}

export function isWithinDeliveryRadius(settings: DeliverySettings, distanceKm: number): boolean {
  return distanceKm <= settings.deliveryRadiusKm;
}
