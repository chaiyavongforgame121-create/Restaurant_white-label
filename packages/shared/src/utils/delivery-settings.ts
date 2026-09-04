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

/**
 * Mirrors Postgres `round(numeric, 2)`: exact decimal, half away from zero.
 *
 * `Math.round(n * 100) / 100` is not the same function. Binary floats lose the
 * half-cent (2.675 * 100 is 267.49999999999997), so it rounds those DOWN while
 * Postgres rounds them up, and the merchant is then shown a cent the server will
 * never charge. Snapping to 15 significant digits — far finer than a cent, far
 * coarser than the float noise — puts the value back on the decimal Postgres sees.
 */
export function round2Exact(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const scaled = Number((n * 100).toPrecision(15));
  return (Math.sign(scaled) || 1) * (Math.round(Math.abs(scaled)) / 100);
}

/** Half away from zero, like Postgres `round(numeric)` — Math.round alone breaks on
 *  negatives (-0.5 goes to -0, not -1). */
function roundHalfUp(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return (Math.sign(n) || 1) * Math.round(Math.abs(n));
}

/**
 * The distance quote_delivery() actually works with.
 *
 * The SQL computes `v_km := round(distance_m / 1000, 2)` FIRST and then uses that
 * rounded value for the radius test, the surge threshold test and the fee. A mirror
 * that skips it disagrees by a cent at most distances — and by a whole multiplier
 * within 0.02 mi of the threshold, where 2.999 mi rounds up to 4.83 km and surges.
 */
export function quoteDistanceKm(distanceKm: number): number {
  return round2Exact(distanceKm);
}

/** The multiplier quote_delivery() will actually apply at this distance. */
export function effectiveSurge(settings: DeliverySettings, distanceKm: number): number {
  const km = quoteDistanceKm(distanceKm);
  return km < settings.deliverySurgeFromKm ? 1 : settings.deliverySurgeMultiplier;
}

/**
 * Mirrors SQL quote_delivery(). The two must land on the same cent — the merchant is shown
 * this number and the server charges its own.
 *
 * The min/max clamp is gone: the owner removed both inputs (2026-08-31) and quote_delivery
 * stopped clamping with them, so keeping a floor and a $9.99 ceiling here would have made
 * the preview disagree with every real order.
 */
export function computeDeliveryFee(settings: DeliverySettings, distanceKm: number): number {
  const km = quoteDistanceKm(distanceKm);
  const fee = Math.max(0, settings.deliveryBaseFee + km * settings.deliveryPerKmFee);
  // Surge starts at a distance now, so a short hop is not multiplied.
  return round2Exact(fee * effectiveSurge(settings, km));
}

/** prep + busy buffer + travel at CITY_SPEED_KMH — identical to quote_delivery() in SQL. */
export function heuristicEtaMin(settings: DeliverySettings, distanceKm: number): number {
  const km = quoteDistanceKm(distanceKm);
  // The SQL turns both minute settings into an int; rounding here rather than truncating
  // matches `round(...)::int`, which is what the companion migration replaced the bare
  // `::int` cast with so a merchant's 15.5 could not abort the whole quote.
  return (
    roundHalfUp(settings.prepTimeMin) +
    roundHalfUp(settings.busyExtraPrepMin) +
    Math.ceil((km / CITY_SPEED_KMH) * 60)
  );
}

export function isWithinDeliveryRadius(settings: DeliverySettings, distanceKm: number): boolean {
  // `if v_km > v_radius then out_of_range`, inverted — and on the ROUNDED km, which is
  // why a drop-off exactly on a 5 mi radius is out of range (8.04672 km rounds to 8.05).
  return quoteDistanceKm(distanceKm) <= settings.deliveryRadiusKm;
}

/** Everything quote_delivery() returns for a deliverable address, in its shape. */
export interface LocalDeliveryQuote {
  deliverable: boolean;
  /** Already rounded — exactly the `distance_km` the RPC would report. */
  distanceKm: number;
  distanceMi: number;
  fee: number;
  etaMin: number;
  /** The multiplier actually applied at this distance, 1 when the trip is too short. */
  surge: number;
}

/**
 * Line-for-line mirror of public.quote_delivery()'s arithmetic; the branch, entitlement
 * and coordinate guards are server-only. Asserted against a transcription of the SQL in
 * delivery-settings.test.ts, which also checks the migration text has not moved.
 */
export function quoteDeliveryLocal(
  settings: DeliverySettings,
  distanceKm: number,
): LocalDeliveryQuote {
  const km = quoteDistanceKm(distanceKm);
  return {
    deliverable: isWithinDeliveryRadius(settings, km),
    distanceKm: km,
    distanceMi: kmToMi(km),
    fee: computeDeliveryFee(settings, km),
    etaMin: heuristicEtaMin(settings, km),
    surge: effectiveSurge(settings, km),
  };
}

const floor2 = (n: number): number => Math.floor(n * 100) / 100;
const ceil2 = (n: number): number => Math.ceil(n * 100) / 100;

/**
 * The farthest sample distance still inside the radius.
 *
 * Stepping down matters: the radius test runs on the 2 dp km, so the mileage that looks
 * exactly on the line is out of range (5 mi is 8.04672 km, which rounds to 8.05 against
 * an 8.04672 km radius). Showing "Out of range" on the row meant to demonstrate the most
 * expensive legal order is the opposite of useful.
 */
function farthestSampleMi(settings: DeliverySettings): number {
  let mi = floor2(round2Exact(kmToMi(settings.deliveryRadiusKm)));
  // 0.01 mi is 16 m and the rounding error is at most 5 m, so this settles in one step.
  for (let i = 0; i < 4 && mi > 0 && !isWithinDeliveryRadius(settings, miToKm(mi)); i += 1) {
    mi = round2Exact(mi - 0.01);
  }
  return Math.max(0, mi);
}

/**
 * The first sample that really pays the multiplier.
 *
 * Not the threshold itself: the surge test also runs on the 2 dp km, so an address exactly
 * 8.00 mi out is still unsurged against an 8 mi threshold (12.874752 km quotes as 12.87,
 * a shade under). Showing "no surge" on the row meant to demonstrate the surge would have
 * been the same kind of lie the old fixed distances told.
 */
function firstSurgedSampleMi(settings: DeliverySettings, capMi: number): number {
  let mi = ceil2(round2Exact(kmToMi(settings.deliverySurgeFromKm)));
  for (let i = 0; i < 4 && mi < capMi && effectiveSurge(settings, miToKm(mi)) === 1; i += 1) {
    mi = round2Exact(mi + 0.01);
  }
  return Math.min(mi, capMi);
}

/** The companion of the above: a sample that provably has NOT surged, so the two rows
 *  read as a before and after rather than as two arbitrary numbers. */
function lastUnsurgedSampleMi(settings: DeliverySettings, startMi: number): number {
  let mi = floor2(startMi);
  for (let i = 0; i < 4 && mi > 0 && effectiveSurge(settings, miToKm(mi)) > 1; i += 1) {
    mi = round2Exact(mi - 0.01);
  }
  return Math.max(0, mi);
}

/**
 * Sample distances for the admin fee preview, derived from THIS branch's own settings:
 * one below the surge threshold, one at the first distance that actually surges, and one
 * at the farthest address the branch will still deliver to.
 *
 * A fixed 1 / 3 / 5 mi could not show a surge that starts at 8 mi, and wasted a column on
 * "Out of range" whenever the radius was under 5 — so the preview read as a canned example
 * of somebody else's restaurant. With surge off (or set past the radius, where it can never
 * fire) the three points spread across the radius instead.
 */
export function previewDistancesMi(settings: DeliverySettings): number[] {
  const radiusMi = round2Exact(kmToMi(settings.deliveryRadiusKm));
  const surgeAtMi = round2Exact(kmToMi(settings.deliverySurgeFromKm));
  const far = farthestSampleMi(settings);
  const showsSurge =
    settings.deliverySurgeMultiplier > 1 && surgeAtMi > 0 && !surgeIsUnreachable(settings);
  const points = showsSurge
    ? [lastUnsurgedSampleMi(settings, surgeAtMi * 0.8), firstSurgedSampleMi(settings, far), far]
    : [floor2(radiusMi / 4), floor2(radiusMi / 2), far];
  return Array.from(new Set(points.map((mi) => Math.min(mi, far)).filter((mi) => mi > 0))).sort(
    (a, b) => a - b,
  );
}

/**
 * True when no deliverable address can ever be surged, because the threshold sits past the
 * radius. Worth saying out loud: the field accepts 9,999,999,999 mi, and the multiplier
 * then looks broken rather than unreachable. Compared against the largest distance the RPC
 * can report inside the radius, so a 5 mi threshold on a 5 mi radius counts as dead — the
 * rounded km never reaches it.
 */
export function surgeIsUnreachable(settings: DeliverySettings): boolean {
  if (settings.deliverySurgeMultiplier <= 1) return false;
  return settings.deliverySurgeFromKm > floor2(settings.deliveryRadiusKm);
}
