import { describe, expect, it } from 'vitest';
import {
  computeTipAmount,
  distributeTip,
  parseTipConfig,
  serializeTipConfig,
  TIP_CONFIG_DEFAULTS,
  TIP_PRESET_DEFAULTS,
  tipPresetsForChannel,
} from './tip-settings';

/**
 * The checkout's tip card is a product decision, not a per-branch setting: three
 * percentages, Custom, No tip — five choices, the same everywhere. These tests
 * pin that list, the rule that a branch row cannot override it, and the
 * chip-to-dollars rounding the diner agrees to on screen.
 */

const CHANNELS = ['pickup', 'dine_in', 'delivery', 'qr_ordering'] as const;

describe('tip presets are product-fixed', () => {
  it('offers exactly 18 / 20 / 25 — with Custom and No tip that is the five choices', () => {
    expect(TIP_PRESET_DEFAULTS).toEqual([18, 20, 25]);
    expect(TIP_PRESET_DEFAULTS).toHaveLength(3);
    expect(TIP_PRESET_DEFAULTS).not.toContain(0);
  });

  it('every channel gets the same list from empty settings', () => {
    for (const ch of CHANNELS) {
      expect(tipPresetsForChannel(parseTipConfig(null), ch)).toEqual([18, 20, 25]);
      expect(tipPresetsForChannel(parseTipConfig(undefined), ch)).toEqual([18, 20, 25]);
      expect(tipPresetsForChannel(parseTipConfig({}), ch)).toEqual([18, 20, 25]);
      expect(TIP_CONFIG_DEFAULTS[ch].presets).toEqual([18, 20, 25]);
    }
  });

  it('ignores a presets list a branch row happens to carry, but still reads the split beside it', () => {
    const cfg = parseTipConfig({
      tip_config: {
        delivery: { presets: [0, 5, 10, 15], distribution: { driver: 80, house: 20 } },
        pickup: { presets: ['10', '15'] },
        dine_in: { presets: 'garbage', distribution: { staff: 60 } },
      },
    });
    expect(cfg.delivery.presets).toEqual([18, 20, 25]);
    expect(cfg.pickup.presets).toEqual([18, 20, 25]);
    expect(cfg.dine_in.presets).toEqual([18, 20, 25]);
    expect(cfg.delivery.workerPct).toBe(80);
    expect(cfg.pickup.workerPct).toBe(100);
    expect(cfg.dine_in.workerPct).toBe(60);
  });

  it('never writes presets back to the row', () => {
    const out = serializeTipConfig(parseTipConfig(null)) as Record<string, Record<string, unknown>>;
    for (const ch of CHANNELS) {
      expect(out[ch]).not.toHaveProperty('presets');
      expect(out[ch]).toHaveProperty('distribution');
    }
  });

  it('hands out a fresh array so a caller cannot mutate the defaults', () => {
    const cfg = parseTipConfig(null);
    cfg.delivery.presets.push(99);
    expect(TIP_PRESET_DEFAULTS).toEqual([18, 20, 25]);
    expect(parseTipConfig(null).delivery.presets).toEqual([18, 20, 25]);
    expect(TIP_CONFIG_DEFAULTS.delivery.presets).toEqual([18, 20, 25]);
  });
});

describe('computeTipAmount (what the checkout sends)', () => {
  it('applies a preset percentage to the subtotal, rounded to the cent', () => {
    expect(computeTipAmount(34.85, 18, '')).toBe(6.27);
    expect(computeTipAmount(34.85, 20, '')).toBe(6.97);
    expect(computeTipAmount(34.85, 25, '')).toBe(8.71);
    expect(computeTipAmount(10, 18, '')).toBe(1.8);
  });

  it('is 0 in the default state — nothing chosen, No tip', () => {
    expect(computeTipAmount(34.85, 0, '')).toBe(0);
    expect(computeTipAmount(0, 20, '')).toBe(0);
  });

  it('a Custom amount wins over any percentage and is clamped at zero', () => {
    expect(computeTipAmount(34.85, 20, '4')).toBe(4);
    expect(computeTipAmount(34.85, 20, '4.999')).toBe(5);
    expect(computeTipAmount(34.85, 20, '2.5')).toBe(2.5);
    expect(computeTipAmount(34.85, 20, '0')).toBe(0);
    expect(computeTipAmount(34.85, 20, '.')).toBe(0);
  });
});

describe('distributeTip still matches the SQL trigger', () => {
  it('splits by workerPct with the remainder to the house', () => {
    const cfg = parseTipConfig({
      tip_config: { delivery: { distribution: { driver: 80, house: 20 } } },
    });
    expect(distributeTip(cfg, 'delivery', 6.27)).toEqual({
      tipAmount: 6.27,
      driverCut: 5.02,
      houseCut: 1.25,
      staffCut: 0,
    });
    expect(distributeTip(parseTipConfig(null), 'dine_in', 6.27)).toEqual({
      tipAmount: 6.27,
      driverCut: 0,
      houseCut: 0,
      staffCut: 6.27,
    });
  });
});
