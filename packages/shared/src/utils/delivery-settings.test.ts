import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DELIVERY_SETTING_DEFAULTS,
  KM_PER_MILE,
  computeDeliveryFee,
  heuristicEtaMin,
  isWithinDeliveryRadius,
  kmToMi,
  miToKm,
  parseDeliverySettings,
  previewDistancesMi,
  quoteDeliveryLocal,
  round2Exact,
  surgeIsUnreachable,
} from './delivery-settings';

describe('parseDeliverySettings', () => {
  it('returns defaults for empty settings', () => {
    expect(parseDeliverySettings(null)).toEqual(DELIVERY_SETTING_DEFAULTS);
    expect(parseDeliverySettings({})).toEqual(DELIVERY_SETTING_DEFAULTS);
  });

  it('reads snake_case keys and coerces string numbers', () => {
    const s = parseDeliverySettings({
      delivery_base_fee: '3.50',
      delivery_per_km_fee: 2,
      delivery_radius_km: 5,
      prep_time_min: 20,
      delivery_fee: 4.99,
    });
    expect(s.deliveryBaseFee).toBe(3.5);
    expect(s.deliveryPerKmFee).toBe(2);
    expect(s.deliveryRadiusKm).toBe(5);
    expect(s.prepTimeMin).toBe(20);
    expect(s.legacyFlatFee).toBe(4.99);
  });

  it('ignores junk values and never lets surge drop below 1', () => {
    const s = parseDeliverySettings({ delivery_base_fee: 'abc', delivery_surge_multiplier: 0.5 });
    expect(s.deliveryBaseFee).toBe(DELIVERY_SETTING_DEFAULTS.deliveryBaseFee);
    expect(s.deliverySurgeMultiplier).toBe(1);
  });
});

describe('computeDeliveryFee — mirrors SQL quote_delivery()', () => {
  const d = DELIVERY_SETTING_DEFAULTS;

  it('matches the SQL quote_delivery() formula: 2.21 km → $5.24', () => {
    // base 2.49 + 2.21 km × ($2.00/mi ÷ 1.609344) = 5.236… → 5.24.
    expect(computeDeliveryFee(d, 2.21)).toBe(5.24);
  });

  it('no longer floors a very short trip — the minimum fee input was removed', () => {
    // 0.1 km → 2.49 + 0.124 = 2.61. Used to be lifted to the 2.99 floor.
    expect(computeDeliveryFee(d, 0.1)).toBe(2.61);
  });

  it('no longer caps a long trip — the maximum fee input was removed', () => {
    // 7.9 km → 2.49 + 9.82 = 12.31. Used to be cut to the 9.99 ceiling, which meant the
    // restaurant absorbed everything past it.
    expect(computeDeliveryFee(d, 7.9)).toBe(12.31);
  });

  it('multiplies by surge', () => {
    const surged = { ...d, deliverySurgeMultiplier: 1.5 };
    // (2.49 + 2 × $2.00/mi-per-km) × 1.5 = 7.46
    expect(computeDeliveryFee(surged, 2)).toBe(7.46);
  });

  it('does not surge a trip shorter than the surge distance', () => {
    const surged = { ...d, deliverySurgeMultiplier: 2, deliverySurgeFromKm: miToKm(5) };
    // 2 km is inside the 5-mile threshold, so the multiplier must not apply.
    expect(computeDeliveryFee(surged, 2)).toBe(computeDeliveryFee({ ...d, deliverySurgeFromKm: miToKm(5) }, 2));
    // 10 mi is beyond it, so it must. The multiplier lands on the RAW fee and the cents are
    // rounded once, exactly as the SQL does it: 16.09344 km is quoted as 16.09, giving
    // 2.49 + 16.09 x $1.2427/km = 22.48572, doubled to 44.97. Doubling the already-rounded
    // $22.49 would say 44.98 - a cent the server would never charge.
    const far = miToKm(10);
    expect(computeDeliveryFee({ ...d }, far)).toBe(22.49);
    expect(computeDeliveryFee(surged, far)).toBe(44.97);
  });
});

describe('heuristicEtaMin — mirrors SQL quote_delivery()', () => {
  const d = DELIVERY_SETTING_DEFAULTS;

  it('matches the live SQL sim: 2.21 km → 21 min', () => {
    expect(heuristicEtaMin(d, 2.21)).toBe(21);
  });

  it('adds the busy-mode buffer', () => {
    expect(heuristicEtaMin({ ...d, busyExtraPrepMin: 10 }, 2.21)).toBe(31);
  });
});

describe('isWithinDeliveryRadius', () => {
  it('checks against the configured radius', () => {
    const d = { ...DELIVERY_SETTING_DEFAULTS, deliveryRadiusKm: 5 };
    expect(isWithinDeliveryRadius(d, 4.99)).toBe(true);
    expect(isWithinDeliveryRadius(d, 5)).toBe(true);
    expect(isWithinDeliveryRadius(d, 5.01)).toBe(false);
  });
});

describe('miles ↔ km conversion (US display layer)', () => {
  it('uses the exact 1 mile = 1.609344 km factor', () => {
    expect(miToKm(1)).toBe(KM_PER_MILE);
    expect(kmToMi(KM_PER_MILE)).toBe(1);
  });

  it('round-trips without drift', () => {
    expect(kmToMi(miToKm(5))).toBeCloseTo(5, 10);
    expect(miToKm(kmToMi(8))).toBeCloseTo(8, 10);
  });

  it('storing $/mile as its $/km equivalent yields the right per-mile fee', () => {
    // Admin enters $2.00/mile → the card stores $2.00 / KM_PER_MILE per km, so the
    // unchanged km-based formula bills the same as a true per-mile rate would.
    const settings = {
      ...DELIVERY_SETTING_DEFAULTS,
      deliveryBaseFee: 0,
      deliveryPerKmFee: 2 / KM_PER_MILE,
    };
    // A 3-mile trip should cost 3 × $2.00 = $6.00.
    expect(computeDeliveryFee(settings, miToKm(3))).toBe(6);
  });
});

// ---------------------------------------------------------------------------
// Parity with the server. Everything above asserts hardcoded cents; what follows
// asserts that those cents are the ones public.quote_delivery() would produce.
// ---------------------------------------------------------------------------

/**
 * A literal transcription of public.quote_delivery()'s arithmetic, statement by statement,
 * from the migration the guard at the bottom of this file pins. Decimal arithmetic is
 * emulated with round2Exact. Written from the SQL rather than from delivery-settings.ts,
 * which is what makes it an oracle instead of a copy of the code under test.
 */
function sqlQuoteDelivery(s: Record<string, number>, rawKm: number) {
  const KM = 1.609344;
  const vKm = round2Exact(rawKm); // v_km := round(distance_m / 1000, 2)
  const vRadius = s.delivery_radius_km ?? 5 * KM;
  if (vKm > vRadius) return { deliverable: false as const };
  const vSurgeFromKm = Math.max(0, s.delivery_surge_from_mi ?? 0) * KM;
  let vSurge = Math.max(1, s.delivery_surge_multiplier ?? 1);
  if (vKm < vSurgeFromKm) vSurge = 1;
  const vFee = (s.delivery_base_fee ?? 2.49) + vKm * (s.delivery_per_km_fee ?? 2 / KM);
  const vEta =
    Math.round(s.prep_time_min ?? 15) +
    Math.round(s.busy_extra_prep_min ?? 0) +
    Math.ceil((vKm / 24.0) * 60);
  return {
    deliverable: true as const,
    distance_km: vKm,
    fee: round2Exact(Math.max(0, vFee) * vSurge),
    eta_min: vEta,
    surge: vSurge,
  };
}

describe('quoteDeliveryLocal is identical to SQL quote_delivery()', () => {
  const CASES: Array<Record<string, number>> = [];
  for (const base of [0, 2.49, 3, 7.5])
    for (const perMi of [0, 2, 3.33, 4.99])
      for (const mult of [1, 1.25, 1.5, 1.75, 2])
        for (const fromMi of [0, 3, 5, 12])
          for (const prep of [0, 15])
            CASES.push({
              delivery_base_fee: base,
              delivery_per_km_fee: perMi / KM_PER_MILE,
              delivery_radius_km: 60 * KM_PER_MILE,
              delivery_surge_from_mi: fromMi,
              delivery_surge_multiplier: mult,
              prep_time_min: prep,
              busy_extra_prep_min: 0,
            });

  it('agrees on fee, ETA, surge and deliverability every 0.05 mi from 0 to 60', () => {
    // Compared without expect() inside the loop: 640 settings x 1201 distances is 769k
    // comparisons, and a matcher per comparison turns a one-second test into a minute.
    const mismatches: string[] = [];
    for (const raw of CASES) {
      const parsed = parseDeliverySettings(raw);
      for (let step = 0; step <= 1200 && mismatches.length < 5; step += 1) {
        const mi = step * 0.05;
        const mine = quoteDeliveryLocal(parsed, mi * KM_PER_MILE);
        const theirs = sqlQuoteDelivery(raw, mi * KM_PER_MILE);
        const where = `${mi} mi @ ${JSON.stringify(raw)}`;
        if (mine.deliverable !== theirs.deliverable) mismatches.push(`${where}: deliverable`);
        if (!theirs.deliverable) continue;
        if (mine.fee !== theirs.fee) mismatches.push(`${where}: fee ${mine.fee} vs ${theirs.fee}`);
        if (mine.etaMin !== theirs.eta_min)
          mismatches.push(`${where}: eta ${mine.etaMin} vs ${theirs.eta_min}`);
        if (mine.surge !== theirs.surge)
          mismatches.push(`${where}: surge ${mine.surge} vs ${theirs.surge}`);
        if (mine.distanceKm !== theirs.distance_km) mismatches.push(`${where}: distance_km`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('agrees about the radius, which is tested on the rounded km', () => {
    const raw = { delivery_radius_km: 5 * KM_PER_MILE };
    const parsed = parseDeliverySettings(raw);
    // 8.04672 km rounds to 8.05, which is past an 8.04672 km radius: 5.0 mi is out.
    expect(quoteDeliveryLocal(parsed, miToKm(5)).deliverable).toBe(false);
    expect(sqlQuoteDelivery(raw, miToKm(5)).deliverable).toBe(false);
    expect(quoteDeliveryLocal(parsed, miToKm(4.99)).deliverable).toBe(true);
    expect(sqlQuoteDelivery(raw, miToKm(4.99)).deliverable).toBe(true);
  });

  it('surges exactly where the server does, on the ROUNDED distance', () => {
    const raw = { delivery_surge_multiplier: 1.5, delivery_surge_from_mi: 3 };
    const parsed = parseDeliverySettings(raw);
    // The multiplier flips between 2.9981 and 2.9982 mi, not at 3: 4.8251 km rounds UP to
    // 4.83, which is already past the 4.828032 km threshold. In that band the old preview
    // disagreed with the server about the multiplier itself, not merely about a cent.
    expect(quoteDeliveryLocal(parsed, 2.9981 * KM_PER_MILE).surge).toBe(1);
    expect(sqlQuoteDelivery(raw, 2.9981 * KM_PER_MILE).surge).toBe(1);
    expect(quoteDeliveryLocal(parsed, 2.9982 * KM_PER_MILE).surge).toBe(1.5);
    expect(sqlQuoteDelivery(raw, 2.9982 * KM_PER_MILE).surge).toBe(1.5);
  });

  it('regression: the cent the old preview lost by skipping round(km, 2)', () => {
    const parsed = parseDeliverySettings({
      delivery_base_fee: 2.49,
      delivery_per_km_fee: 3.33 / KM_PER_MILE,
      delivery_radius_km: 60 * KM_PER_MILE,
      delivery_surge_multiplier: 1.5,
      delivery_surge_from_mi: 3,
    });
    expect(quoteDeliveryLocal(parsed, miToKm(5)).fee).toBe(28.72); // preview used to say 28.71
  });

  it('rounds the half-cent the way Postgres numeric does, not the way a float does', () => {
    // 2.675 * 100 is 267.49999999999997 in binary, so Math.round takes it DOWN to 2.67.
    expect(round2Exact(2.675)).toBe(2.68);
    expect(round2Exact(1.005)).toBe(1.01);
    expect(round2Exact(-2.675)).toBe(-2.68);
  });
});

describe('previewDistancesMi picks distances that exercise these settings', () => {
  it('brackets the surge threshold and ends at the farthest deliverable address', () => {
    const s = parseDeliverySettings({
      delivery_radius_km: miToKm(10),
      delivery_surge_from_mi: 8,
      delivery_surge_multiplier: 1.5,
    });
    // A fixed 1 / 3 / 5 mi could never have shown this branch's surge at all. 8.01 rather
    // than 8.00 because 12.874752 km quotes as 12.87, a shade under the threshold.
    expect(previewDistancesMi(s)).toEqual([6.4, 8.01, 10]);
    const pts = previewDistancesMi(s);
    expect(quoteDeliveryLocal(s, miToKm(pts[0]!)).surge).toBe(1);
    expect(quoteDeliveryLocal(s, miToKm(pts[1]!)).surge).toBe(1.5);
    expect(pts.every((mi) => quoteDeliveryLocal(s, miToKm(mi)).deliverable)).toBe(true);
  });

  it('never wastes a column on an out-of-range sample', () => {
    for (const radiusMi of [0.4, 1, 3, 5, 7.5, 12, 50]) {
      const s = parseDeliverySettings({ delivery_radius_km: miToKm(radiusMi) });
      const pts = previewDistancesMi(s);
      expect(pts.length).toBeGreaterThan(0);
      for (const mi of pts) expect(quoteDeliveryLocal(s, miToKm(mi)).deliverable).toBe(true);
    }
  });

  it('spreads across the radius when surge is off or unreachable', () => {
    const off = parseDeliverySettings({ delivery_radius_km: miToKm(10) });
    expect(previewDistancesMi(off)).toEqual([2.5, 5, 10]);
    const dead = parseDeliverySettings({
      delivery_radius_km: miToKm(10),
      delivery_surge_from_mi: 50,
      delivery_surge_multiplier: 2,
    });
    expect(previewDistancesMi(dead)).toEqual([2.5, 5, 10]);
  });

  it('backs off the radius when the mileage on the line would quote as out of range', () => {
    // The default 5 mi radius is 8.04672 km, and 5.00 mi quotes as 8.05 - out. 4.99 is the
    // real edge of the map, and the merchant should be shown that fee, not "Out of range".
    const s = parseDeliverySettings({});
    expect(previewDistancesMi(s)).toEqual([1.25, 2.5, 4.99]);
  });
});

describe('surgeIsUnreachable', () => {
  it('is false while the threshold is reachable', () => {
    const s = parseDeliverySettings({
      delivery_radius_km: miToKm(10),
      delivery_surge_from_mi: 8,
      delivery_surge_multiplier: 1.5,
    });
    expect(surgeIsUnreachable(s)).toBe(false);
  });

  it('is true when the threshold sits past the radius', () => {
    const s = parseDeliverySettings({
      delivery_radius_km: miToKm(10),
      delivery_surge_from_mi: 50,
      delivery_surge_multiplier: 1.5,
    });
    expect(surgeIsUnreachable(s)).toBe(true);
  });

  it('is true when the threshold equals the radius - the rounded km never reaches it', () => {
    const s = parseDeliverySettings({
      delivery_radius_km: miToKm(5),
      delivery_surge_from_mi: 5,
      delivery_surge_multiplier: 2,
    });
    expect(surgeIsUnreachable(s)).toBe(true);
    expect(quoteDeliveryLocal(s, miToKm(4.99)).surge).toBe(1);
  });

  it('says nothing while the multiplier is off', () => {
    const s = parseDeliverySettings({ delivery_surge_from_mi: 500 });
    expect(surgeIsUnreachable(s)).toBe(false);
  });
});

describe('the SQL this file mirrors has not moved', () => {
  // Pinned to the NEWEST migration that defines quote_delivery, not to a fixed filename:
  // a later migration redefining the function would otherwise leave this guard matching a
  // superseded file and reporting parity it no longer checks.
  const dir = fileURLToPath(new URL('../../../../supabase/migrations/', import.meta.url));
  const defining = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .filter((f) => readFileSync(dir + f, 'utf8').includes('function public.quote_delivery('))
    .sort();
  const sql = defining.length ? readFileSync(dir + defining[defining.length - 1]!, 'utf8') : '';

  it('finds a migration that defines quote_delivery', () => {
    expect(defining.length).toBeGreaterThan(0);
  });

  it.each([
    'v_km := round((ST_Distance(b.geo_location, ST_SetSRID(ST_MakePoint(p_lng, p_lat), 4326)::geography) / 1000.0)::numeric, 2)',
    "v_surge_from_km := greatest(0, coalesce((s->>'delivery_surge_from_mi')::numeric, 0)) * 1.609344",
    "v_surge := greatest(1, coalesce((s->>'delivery_surge_multiplier')::numeric, 1))",
    'if v_km < v_surge_from_km then v_surge := 1; end if',
    'v_fee := round(greatest(0, v_fee) * v_surge, 2)',
    "'out_of_range'",
    "'delivery_not_entitled'",
  ])('still contains: %s', (fragment) => {
    expect(sql).toContain(fragment);
  });
});
