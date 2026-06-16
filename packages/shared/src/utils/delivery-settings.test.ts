import { describe, expect, it } from 'vitest';
import {
  DELIVERY_SETTING_DEFAULTS,
  computeDeliveryFee,
  heuristicEtaMin,
  isWithinDeliveryRadius,
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

  it('matches the live SQL sim: 2.21 km → $5.25', () => {
    // Verified against quote_delivery() on the live DB 2026-06-11.
    expect(computeDeliveryFee(d, 2.21)).toBe(5.25);
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
    // clamp(2.49 + 2.5, 2.99, 9.99) = 4.99 → ×1.5 = 7.485 → 7.49 (can exceed max)
    expect(computeDeliveryFee(surged, 2)).toBe(7.49);
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
