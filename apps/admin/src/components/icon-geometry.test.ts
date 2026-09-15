import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ICON_STYLE,
  MASKABLE_VISIBLE_FRACTION,
  PADDED_MASKABLE_SCALE,
  clampZoom,
  colourDistance,
  edgeSwatches,
  iconDrawRect,
  isBrandingAssetUrl,
  knockOutBackground,
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

  it('draws the iPhone icon whole, never zoomed', () => {
    expect(iconDrawRect(512, 512, 180, fill(1.5), 'apple')).toEqual({ x: 0, y: 0, w: 180, h: 180 });
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

  it('carries the remove-background choice through parse, normalise and compare', () => {
    expect(parseIconStyle({ fit: 'fill', zoom: 1, background: '#18555B', removeBackground: true })).toEqual({
      fit: 'fill',
      zoom: 1,
      background: '#18555B',
      removeBackground: true,
    });
    expect(parseIconStyle({ removeBackground: 'yes' }).removeBackground).toBeUndefined();
    expect(sameIconStyle(fill(), { ...fill(), removeBackground: true })).toBe(false);
    expect(sameIconStyle({ ...fill(), removeBackground: false }, fill())).toBe(true);
  });

  it('carries transparency and the iPhone icon URL; only transparency is a look', () => {
    const apple = 'https://abc.supabase.co/storage/v1/object/public/branding/r1/icon-apple-180-x.png';
    const s = parseIconStyle({ fit: 'fill', zoom: 1, background: '#B1320C', transparent: true, appleUrl: apple });
    expect(s.transparent).toBe(true);
    expect(s.appleUrl).toBe(apple);
    expect(parseIconStyle({ appleUrl: 'https://evil.example/a.png' }).appleUrl).toBeUndefined();
    expect(parseIconStyle({ transparent: 'yes' }).transparent).toBeUndefined();
    expect(sameIconStyle(fill(), { ...fill(), transparent: true })).toBe(false);
    expect(sameIconStyle(fill(), { ...fill(), appleUrl: apple })).toBe(true);
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

  it('removes the white around a badge but keeps white enclosed by the artwork', () => {
    const size = 96;
    const data = badge(size);
    const c = (size - 1) / 2;
    // White "lettering" inside the orange face.
    for (let y = 44; y < 52; y++) {
      for (let x = 40; x < 56; x++) {
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
      }
    }
    const result = knockOutBackground(data, size, size);
    expect(result.reference).toBe('#FFFFFF');
    expect(result.removed).toBeGreaterThan(0);
    const alpha = (x: number, y: number) => data[(y * size + x) * 4 + 3];
    expect(alpha(0, 0)).toBe(0); // corner
    expect(alpha(size - 1, size - 1)).toBe(0);
    expect(alpha(47, 47)).toBe(255); // enclosed white lettering survives
    expect(alpha(Math.round(c), Math.round(c))).toBe(255); // face
    // The teal rim stays opaque and teal.
    const rimX = Math.round(c + (size / 2) * 0.91);
    const rimY = Math.round(c);
    expect(alpha(rimX, rimY)).toBe(255);
    expect(data[(rimY * size + rimX) * 4]).toBe(26);
  });

  it('leaves photos and already-transparent images alone', () => {
    const size = 32;
    const noisy = new Uint8ClampedArray(size * size * 4);
    for (let p = 0; p < size * size; p++) {
      noisy[p * 4] = (p * 37) % 256;
      noisy[p * 4 + 1] = (p * 91) % 256;
      noisy[p * 4 + 2] = (p * 53) % 256;
      noisy[p * 4 + 3] = 255;
    }
    const before = noisy.slice();
    expect(knockOutBackground(noisy, size, size)).toEqual({ removed: 0, reference: null });
    expect(noisy).toEqual(before);
    expect(knockOutBackground(new Uint8ClampedArray(size * size * 4), size, size).removed).toBe(0);
  });

  it('softens the cut edge without leaving a pale halo', () => {
    // A 1px light-teal antialiased ring between white background and the teal rim.
    const w = 9;
    const h = 9;
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const inner = x >= 3 && x <= 5 && y >= 3 && y <= 5;
        const ring = !inner && x >= 2 && x <= 6 && y >= 2 && y <= 6;
        const [r, g, b] = inner ? [26, 107, 107] : ring ? [150, 190, 190] : [255, 255, 255];
        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
        data[i + 3] = 255;
      }
    }
    knockOutBackground(data, w, h);
    const ring = (2 * w + 4) * 4;
    expect(data[ring + 3]).toBeGreaterThan(0);
    expect(data[ring + 3]).toBeLessThan(255);
    // Its colour is pulled away from white, toward the teal it was blended from.
    expect(data[ring]).toBeLessThan(150);
    expect(data[(4 * w + 4) * 4 + 3]).toBe(255);
  });

  it('treats a plain background sitting on a colour step as plain, and keeps the artwork', () => {
    const w = 60;
    const h = 20;
    const make = (shade: (x: number, y: number) => number) => {
      const d = new Uint8ClampedArray(w * h * 4);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const art = x >= 20 && x < 40 && y >= 5 && y < 15;
          const v = art ? 20 : shade(x, y);
          d[i] = v;
          d[i + 1] = v;
          d[i + 2] = v;
          d[i + 3] = 255;
        }
      }
      return d;
    };
    // 239/241 noise straddles the 240 step between two 16-level buckets.
    const noisy = make((x, y) => ((x + y) % 2 ? 239 : 241));
    expect(knockOutBackground(noisy, w, h).removed).toBeGreaterThan(0);
    // A scanned-paper gradient from #FAFAFA down to #ECECEC.
    const paper = make((_x, y) => Math.round(0xfa - (y / (h - 1)) * (0xfa - 0xec)));
    expect(knockOutBackground(paper, w, h).removed).toBeGreaterThan(0);
    expect(paper[(0 * w + 0) * 4 + 3]).toBe(0);
    expect(paper[(10 * w + 30) * 4 + 3]).toBe(255);
  });

  it('measures colour distance, and treats junk as infinitely far', () => {
    expect(colourDistance('#FFFFFF', '#FFFFFF')).toBe(0);
    expect(colourDistance('#000000', '#FFFFFF')).toBeCloseTo(441.67, 1);
    expect(colourDistance('red', '#FFFFFF')).toBe(Number.POSITIVE_INFINITY);
  });

  it('skips transparent pixels and rejects bad input', () => {
    const clear = new Uint8ClampedArray(16 * 16 * 4);
    expect(edgeSwatches(clear, 16, 16)).toEqual([]);
    expect(edgeSwatches(new Uint8ClampedArray(4), 16, 16)).toEqual([]);
  });
});
