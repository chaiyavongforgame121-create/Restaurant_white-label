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
    expect(s.deliveryMinFee).toBe(DELIVERY_SETTING_DEFAULTS.deliveryMinFee);
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

  it('applies the min-fee floor for very short trips', () => {
    // 0.1 km → 2.49 + 0.125 = 2.615 < 2.99 floor
    expect(computeDeliveryFee(d, 0.1)).toBe(2.99);
  });

  it('applies the max-fee ceiling for long trips', () => {
    // 7.9 km → 2.49 + 9.875 = 12.365 > 9.99 ceiling
    expect(computeDeliveryFee(d, 7.9)).toBe(9.99);
  });

  it('multiplies surge after the clamp', () => {
    const surged = { ...d, deliverySurgeMultiplier: 1.5 };
    // clamp(2.49 + 2×$2.00/mi-per-km, 2.99, 9.99) = 4.975… → ×1.5 = 7.46 (can exceed max)
    expect(computeDeliveryFee(surged, 2)).toBe(7.46);
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
      deliveryMinFee: 0,
      deliveryMaxFee: 999,
    };
    // A 3-mile trip should cost 3 × $2.00 = $6.00.
    expect(computeDeliveryFee(settings, miToKm(3))).toBe(6);
  });
});
