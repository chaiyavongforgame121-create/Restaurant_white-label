import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_STYLE,
  MASKABLE_VISIBLE_FRACTION,
  PADDED_MASKABLE_SCALE,
  clampZoom,
  edgeSwatches,
  iconDrawRect,
  isBrandingAssetUrl,
  mergeSwatches,
  normalizeIconStyle,
  parseIconStyle,
  sameIconStyle,
  type IconStyle,
} from './icon-geometry';

const fill = (zoom = 1): IconStyle => ({ fit: 'fill', zoom, background: '#FFFFFF' });
const padded: IconStyle = { fit: 'padded', zoom: 1, background: '#FFFFFF' };
const SOURCE = 'https://abc.supabase.co/storage/v1/object/public/branding/r1/icon-source-x.png';

describe('iconDrawRect', () => {
  it('fills the whole Android tile by default — no white frame', () => {
    expect(iconDrawRect(512, 512, 512, fill(), 'maskable')).toEqual({ x: 0, y: 0, w: 512, h: 512 });
  });

  it('zooms the Android icon past the tile edges, centred', () => {
    const r = iconDrawRect(512, 512, 512, fill(1.2), 'maskable');
    expect(r.w).toBeCloseTo(614.4);
    expect(r.x).toBeCloseTo(-51.2);
    expect(r.x + r.w / 2).toBeCloseTo(256);
  });

  it('never zooms or crops the tab/iPhone/desktop icon', () => {
    expect(iconDrawRect(512, 512, 192, fill(1.5), 'any')).toEqual({ x: 0, y: 0, w: 192, h: 192 });
    // A wide wordmark is letterboxed in every style, never cut.
    for (const style of [fill(), fill(1.4), padded]) {
      const r = iconDrawRect(1000, 500, 512, style, 'any');
      expect(r.w).toBeCloseTo(512);
      expect(r.h).toBeCloseTo(256);
      expect(r.y).toBeCloseTo(128);
    }
  });

  it('covers a non-square image on the Android tile in fill mode', () => {
    const cover = iconDrawRect(1000, 500, 512, fill(), 'maskable');
    expect(cover.h).toBeCloseTo(512);
    expect(cover.w).toBeCloseTo(1024);
  });

  it('keeps the old safe inset for Keep padding', () => {
    const r = iconDrawRect(512, 512, 512, padded, 'maskable');
    expect(r.w).toBeCloseTo(512 * PADDED_MASKABLE_SCALE);
    expect(r.x).toBeCloseTo((512 - 512 * PADDED_MASKABLE_SCALE) / 2);
  });

  it('survives nonsense dimensions', () => {
    expect(iconDrawRect(0, 0, 192, fill(), 'any')).toEqual({ x: 0, y: 0, w: 192, h: 192 });
  });
});

describe('launcher crop', () => {
  it('matches Chromium: 80% safe zone mapped onto a 66dp safe zone in a 72dp viewport', () => {
    expect(MASKABLE_VISIBLE_FRACTION).toBeCloseTo(0.8727, 4);
  });
});

describe('style parsing', () => {
  it('clamps zoom to 100–150%', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(9)).toBe(1.5);
    expect(clampZoom(1.234)).toBe(1.23);
    expect(clampZoom(Number.NaN)).toBe(1);
  });

  it('reads a saved style and falls back on anything odd', () => {
    expect(parseIconStyle({ fit: 'fill', zoom: 1.1, background: '#1a6b6b' })).toEqual({
      fit: 'fill',
      zoom: 1.1,
      background: '#1A6B6B',
    });
    expect(parseIconStyle(null)).toEqual(DEFAULT_ICON_STYLE);
    expect(parseIconStyle({ fit: 'weird', zoom: 'x', background: 'red' })).toEqual(DEFAULT_ICON_STYLE);
  });

  it('keeps a source URL only when it is a branding-bucket file', () => {
    expect(parseIconStyle({ fit: 'fill', zoom: 1, background: '#FFFFFF', sourceUrl: SOURCE }).sourceUrl).toBe(SOURCE);
    expect(parseIconStyle({ sourceUrl: 'https://evil.example/x.png' }).sourceUrl).toBeUndefined();
    expect(parseIconStyle({ sourceUrl: 'javascript:alert(1)' }).sourceUrl).toBeUndefined();
    expect(isBrandingAssetUrl(SOURCE)).toBe(true);
    expect(isBrandingAssetUrl('https://abc.supabase.co/storage/v1/object/public/menu/x.png')).toBe(false);
  });

  it('saves padded styles with zoom 1, since zoom does nothing there', () => {
    expect(normalizeIconStyle({ fit: 'padded', zoom: 1.4, background: '#abcdef' })).toEqual({
      fit: 'padded',
      zoom: 1,
      background: '#ABCDEF',
    });
  });

  it('compares what renders: zoom only in fill mode, never the source URL', () => {
    expect(sameIconStyle(fill(1.1), { fit: 'fill', zoom: 1.1, background: '#ffffff' })).toBe(true);
    expect(sameIconStyle(fill(1.1), fill(1.15))).toBe(false);
    expect(sameIconStyle(padded, { ...padded, zoom: 1.4 })).toBe(true);
    expect(sameIconStyle(fill(), { ...fill(), sourceUrl: SOURCE })).toBe(true);
    expect(sameIconStyle(null, fill())).toBe(false);
  });
});

describe('edgeSwatches', () => {
  /**
   * A round badge on white, measured from the real Coastal Grill icon: the badge ends at 0.945
   * of the half-width with a teal rim from about 0.89, orange face inside.
   */
  function badge(size: number): Uint8ClampedArray {
    const data = new Uint8ClampedArray(size * size * 4);
    const c = (size - 1) / 2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = Math.hypot(x - c, y - c) / (size / 2);
        const [r, g, b] = d <= 0.885 ? [242, 160, 60] : d <= 0.945 ? [26, 107, 107] : [255, 255, 255];
        const i = (y * size + x) * 4;
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    return data;
  }

  it('offers the background and the badge rim', () => {
    const swatches = edgeSwatches(badge(96), 96, 96);
    expect(swatches[0]).toBe('#FFFFFF');
    expect(swatches).toContain('#1A6B6B');
    expect(swatches).toContain('#F2A03C');
    expect(swatches.length).toBeLessThanOrEqual(4);
  });

  it('merges near-identical colours, keeping exact extras', () => {
    expect(mergeSwatches(['#FDFDFD', '#1A6B6B', '#1C6D6C'], ['#FFFFFF', '#000000'])).toEqual([
      '#FFFFFF',
      '#1A6B6B',
      '#000000',
    ]);
    // #181818 is 12 away from #111111 — the same swatch; #333333 (~59 away) is a different one.
    expect(mergeSwatches(['#111111', '#181818', '#333333', '#F0F0F0'], [], 2)).toEqual(['#111111', '#333333']);
  });

  it('skips transparent pixels and rejects bad input', () => {
    const clear = new Uint8ClampedArray(16 * 16 * 4);
    expect(edgeSwatches(clear, 16, 16)).toEqual([]);
    expect(edgeSwatches(new Uint8ClampedArray(4), 16, 16)).toEqual([]);
  });
});
