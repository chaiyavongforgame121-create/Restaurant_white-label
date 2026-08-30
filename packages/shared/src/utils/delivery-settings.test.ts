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

const round2Local = (n: number) => Math.round(n * 100) / 100;

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
    // 10 mi is beyond it, so it must.
    const far = miToKm(10);
    expect(computeDeliveryFee(surged, far)).toBe(round2Local(computeDeliveryFee({ ...d }, far) * 2));
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
