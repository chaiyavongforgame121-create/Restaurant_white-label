/**
 * Geometry and colour picking for the app icons the admin uploader renders. No DOM, so the
 * uploader, its live preview and the tests share one answer.
 *
 * Why this exists: the Android (maskable) icon used to be the upload shrunk to 62.5% and centred
 * on a white square, so that nothing could ever be cut off by a launcher's mask. Launchers show
 * far more of that square than the worst-case safe zone, and the result on a real phone was the
 * merchant's badge floating in a thick white frame. A merchant now chooses: fill the tile (the
 * default), with optional zoom and a background taken from the image's own edge, or keep the
 * padding.
 */

export type IconFit = 'fill' | 'padded';
/** `any` is the desktop/iOS/tab icon; `maskable` is what Android launchers crop to a shape. */
export type IconVariant = 'any' | 'maskable';

export interface IconStyle {
  fit: IconFit;
  /** Extra zoom on the Android icon in fill mode, 1–1.5. At 1 the image just covers the tile. */
  zoom: number;
  /** Opaque ground painted behind the image, #RRGGBB. iOS renders transparency as black. */
  background: string;
  /**
   * The untouched upload, transparency kept, so a later restyle can still change the background
   * and the crop. Absent for icons made before it was stored — those can only be restyled from
   * the rendered 512, whose background is already baked in.
   */
  sourceUrl?: string;
}

export const ICON_ZOOM_MIN = 1;
export const ICON_ZOOM_MAX = 1.5;
/** The old inset, kept for "Keep padding": survives every mask shape Android ships. */
export const PADDED_MASKABLE_SCALE = 0.625;

/**
 * Share of a maskable tile (by width) an Android launcher actually shows. Chrome pads the icon so
 * the spec's 80% safe zone lands on Android's 66dp adaptive safe zone, and only the 72dp viewport
 * of the 108dp layer is visible (Chromium WebappsIconUtils). The launcher's mask is cut inside
 * that, so a preview drawn at 100% of the tile promises edges the phone never shows.
 */
export const MASKABLE_VISIBLE_FRACTION = (4 / 5) * (72 / 66);

export const DEFAULT_ICON_STYLE: Readonly<IconStyle> = Object.freeze({
  fit: 'fill',
  zoom: 1,
  background: '#FFFFFF',
});

const HEX6 = /^#[0-9a-f]{6}$/i;

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return ICON_ZOOM_MIN;
  const clamped = Math.min(ICON_ZOOM_MAX, Math.max(ICON_ZOOM_MIN, zoom));
  return Math.round(clamped * 100) / 100;
}

/** Only a public file in the branding bucket can be an icon source. */
export function isBrandingAssetUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === 'https:' || url.protocol === 'http:') &&
      url.pathname.startsWith('/storage/v1/object/public/branding/')
    );
  } catch {
    return false;
  }
}

/** brands.theme.appIcon as saved. Anything unrecognised falls back to the defaults. */
export function parseIconStyle(raw: unknown): IconStyle {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ICON_STYLE };
  const r = raw as Record<string, unknown>;
  const zoom = typeof r.zoom === 'number' ? r.zoom : Number(r.zoom);
  const style: IconStyle = {
    fit: r.fit === 'padded' ? 'padded' : 'fill',
    zoom: Number.isFinite(zoom) ? clampZoom(zoom) : DEFAULT_ICON_STYLE.zoom,
    background:
      typeof r.background === 'string' && HEX6.test(r.background)
        ? r.background.toUpperCase()
        : DEFAULT_ICON_STYLE.background,
  };
  if (isBrandingAssetUrl(r.sourceUrl)) style.sourceUrl = r.sourceUrl;
  return normalizeIconStyle(style);
}

/** The form a style is saved in: zoom only where it changes pixels, colours upper-case. */
export function normalizeIconStyle(style: IconStyle): IconStyle {
  const out: IconStyle = {
    fit: style.fit === 'padded' ? 'padded' : 'fill',
    zoom: style.fit === 'padded' ? 1 : clampZoom(style.zoom),
    background: HEX6.test(style.background) ? style.background.toUpperCase() : DEFAULT_ICON_STYLE.background,
  };
  if (style.sourceUrl) out.sourceUrl = style.sourceUrl;
  return out;
}

/**
 * Whether two styles render the same pixels. Zoom is ignored for padded icons (iconDrawRect never
 * reads it there) and the source URL is not a look at all.
 */
export function sameIconStyle(a: IconStyle | null | undefined, b: IconStyle | null | undefined): boolean {
  if (!a || !b) return false;
  return (
    a.fit === b.fit &&
    (a.fit === 'padded' || clampZoom(a.zoom) === clampZoom(b.zoom)) &&
    a.background.toUpperCase() === b.background.toUpperCase()
  );
}

export interface DrawRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Where to draw a srcW×srcH image on a size×size canvas.
 *
 * any:      always contain. The browser tab, the iPhone home screen and desktop installs show
 *           the whole image; a wide wordmark is letterboxed, never cut.
 * maskable: fill → cover × zoom, so the image reaches every edge of the Android tile;
 *           padded → contain × PADDED_MASKABLE_SCALE.
 */
export function iconDrawRect(
  srcW: number,
  srcH: number,
  size: number,
  style: IconStyle,
  variant: IconVariant,
): DrawRect {
  if (!(srcW > 0) || !(srcH > 0) || !(size > 0)) return { x: 0, y: 0, w: size, h: size };
  let scale: number;
  if (variant === 'any') {
    scale = Math.min(size / srcW, size / srcH);
  } else if (style.fit === 'fill') {
    scale = Math.max(size / srcW, size / srcH) * clampZoom(style.zoom);
  } else {
    scale = Math.min(size / srcW, size / srcH) * PADDED_MASKABLE_SCALE;
  }
  const w = srcW * scale;
  const h = srcH * scale;
  return { x: (size - w) / 2, y: (size - h) / 2, w, h };
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b]
    .map((v) => Math.min(255, Math.max(0, Math.round(v))).toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;
}

/**
 * The colours at the edge of an image, most common first — the natural background choices.
 *
 * Samples just inside the square's border (what shows behind a square logo) and three rings
 * near the rim of the inscribed circle (the outer colour of a round badge, which is what makes a
 * filled tile look seamless). Transparent pixels are skipped; colours are bucketed coarsely so
 * JPEG noise does not split one colour into many.
 */
export function edgeSwatches(data: ArrayLike<number>, width: number, height: number, max = 4): string[] {
  if (!(width > 0) || !(height > 0) || data.length < width * height * 4) return [];
  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();

  const sample = (fx: number, fy: number) => {
    const x = Math.min(width - 1, Math.max(0, Math.round(fx)));
    const y = Math.min(height - 1, Math.max(0, Math.round(fy)));
    const i = (y * width + x) * 4;
    if ((data[i + 3] ?? 0) < 200) return;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = `${r >> 5}:${g >> 5}:${b >> 5}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.n += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  };

  const steps = 64;
  const inset = Math.max(1, Math.round(Math.min(width, height) * 0.02));
  for (let s = 0; s < steps; s++) {
    const t = (s + 0.5) / steps;
    sample(t * (width - 1), inset);
    sample(t * (width - 1), height - 1 - inset);
    sample(inset, t * (height - 1));
    sample(width - 1 - inset, t * (height - 1));
  }

  // Fractions of the HALF-width: a round badge's rim sits just inside its edge. (The first
  // version sampled 0.42–0.48 of the half-width, which is the middle of the badge's face, and
  // never offered Coastal Grill's teal rim.)
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const radius = Math.min(width, height) / 2;
  for (const f of [0.86, 0.9, 0.94]) {
    for (let s = 0; s < steps; s++) {
      const a = (2 * Math.PI * s) / steps;
      sample(cx + Math.cos(a) * radius * f, cy + Math.sin(a) * radius * f);
    }
  }

  const ranked = [...buckets.values()].filter((b) => b.n >= 3).sort((a, b) => b.n - a.n);
  return mergeSwatches(
    ranked.map((b) => toHex(b.r / b.n, b.g / b.n, b.b / b.n)),
    [],
    max,
  );
}

function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX6.test(hex)) return null;
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Close enough that two swatches would look like the same choice. */
const SWATCH_MIN_DISTANCE = 28;

function nearlySame(a: string, b: string): boolean {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return a.toUpperCase() === b.toUpperCase();
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]) < SWATCH_MIN_DISTANCE;
}

/**
 * `picked` in order, then `extras`, dropping any colour that looks like one already kept — so a
 * JPEG's #FDFDFD and the white extra do not appear as two identical circles. An extra that
 * duplicates a picked colour is replaced by its exact value (white stays #FFFFFF).
 */
export function mergeSwatches(picked: string[], extras: string[], max = Number.POSITIVE_INFINITY): string[] {
  const out: string[] = [];
  for (const raw of picked) {
    const hex = raw.toUpperCase();
    if (out.some((h) => nearlySame(h, hex))) continue;
    out.push(hex);
    if (out.length >= max) return out;
  }
  for (const raw of extras) {
    const hex = raw.toUpperCase();
    const i = out.findIndex((h) => nearlySame(h, hex));
    if (i >= 0) out[i] = hex;
    else out.push(hex);
  }
  return out;
}
