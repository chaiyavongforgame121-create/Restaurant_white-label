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
export type IconVariant = 'any' | 'maskable' | 'apple';

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
  /**
   * Make the plain colour around the image transparent before rendering (knockOutBackground), so
   * `background` shows there instead — a round badge on white gets no white corners. Omitted
   * when false.
   */
  removeBackground?: boolean;
  /**
   * Leave the `any` icons (browser tab, computer install window and shortcut) transparent, so
   * they show only the image — like the PNG the merchant uploaded. Phones cannot: iOS fills
   * transparency with black and Android launchers with black or white, so the maskable and Apple
   * icons still get `background`. Omitted when false.
   */
  transparent?: boolean;
  /**
   * The opaque 180px iPhone icon rendered alongside, used as apple-touch-icon so the transparent
   * 192 never reaches iOS. A file, not a look: ignored by sameIconStyle.
   */
  appleUrl?: string;
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
  if (r.removeBackground === true) style.removeBackground = true;
  if (r.transparent === true) style.transparent = true;
  if (isBrandingAssetUrl(r.appleUrl)) style.appleUrl = r.appleUrl;
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
  if (style.removeBackground === true) out.removeBackground = true;
  if (style.transparent === true) out.transparent = true;
  if (style.appleUrl) out.appleUrl = style.appleUrl;
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
    a.background.toUpperCase() === b.background.toUpperCase() &&
    (a.removeBackground === true) === (b.removeBackground === true) &&
    (a.transparent === true) === (b.transparent === true)
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
  if (variant === 'any' || variant === 'apple') {
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

/** Straight-line RGB distance between two #RRGGBB colours; Infinity when either is not one. */
export function colourDistance(a: string, b: string): number {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  if (!x || !y) return Number.POSITIVE_INFINITY;
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
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
export interface KnockOutResult {
  /** Pixels made fully transparent. 0 means nothing was changed. */
  removed: number;
  /** The background colour that was removed, #RRGGBB, or null when none was found. */
  reference: string | null;
}

/** Share of the border that must be one colour before it counts as a plain background. */
const PLAIN_BORDER_SHARE = 0.6;

/**
 * Make the plain background around an image transparent, in place (RGBA, straight alpha).
 *
 * The background is the colour most of the border shares. Every pixel CONNECTED to the border
 * and within `tolerance` of that colour is removed, so the same colour enclosed by the artwork —
 * white lettering inside a badge — is kept: nothing links it to the edge. The cut is then
 * softened: pixels touching the removed area that are still close to the background become
 * partly transparent, with the background's tint taken back out of their colour, so no pale
 * halo shows once a different colour is painted behind.
 *
 * Does nothing (removed: 0) when the border is not mostly one opaque colour — a photo, or an
 * image that is already transparent.
 */
export function knockOutBackground(
  data: Uint8ClampedArray,
  width: number,
  height: number,
  tolerance = 40,
): KnockOutResult {
  const count = width * height;
  if (!(width > 1) || !(height > 1) || data.length < count * 4) return { removed: 0, reference: null };

  const forEachBorder = (fn: (p: number) => void) => {
    for (let x = 0; x < width; x++) {
      fn(x);
      fn((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      fn(y * width);
      fn(y * width + width - 1);
    }
  };

  const buckets = new Map<string, { n: number; r: number; g: number; b: number }>();
  forEachBorder((p) => {
    const i = p * 4;
    if ((data[i + 3] ?? 0) < 200) return;
    const r = data[i] ?? 0;
    const g = data[i + 1] ?? 0;
    const b = data[i + 2] ?? 0;
    const key = `${r >> 4}:${g >> 4}:${b >> 4}`;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.n += 1;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
    } else {
      buckets.set(key, { n: 1, r, g, b });
    }
  });
  // Seed: the bucket whose 3×3×3 neighbourhood holds the most border pixels. Counting single
  // 16-level buckets split a plain colour sitting on a step (a #FAFAFA→#ECECEC paper gradient,
  // 239/241 JPEG noise) into two halves that each missed the 60% bar.
  let seed: [number, number, number] | null = null;
  let seedCount = 0;
  for (const key of buckets.keys()) {
    const [kr, kg, kb] = key.split(':').map(Number) as [number, number, number];
    let n = 0;
    let sr = 0;
    let sg = 0;
    let sb = 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dg = -1; dg <= 1; dg++) {
        for (let db = -1; db <= 1; db++) {
          const q = buckets.get(`${kr + dr}:${kg + dg}:${kb + db}`);
          if (q) {
            n += q.n;
            sr += q.r;
            sg += q.g;
            sb += q.b;
          }
        }
      }
    }
    if (n > seedCount) {
      seedCount = n;
      seed = [sr / n, sg / n, sb / n];
    }
  }
  if (!seed) return { removed: 0, reference: null };

  // Reference: the mean of the border pixels within `tolerance` of the seed. The border is plain
  // only when 60% of ALL border pixels (transparent ones count against it) are within `tolerance`
  // of that mean — the same distance the fill below uses.
  const near = (i: number, c: readonly [number, number, number]) =>
    Math.hypot((data[i] ?? 0) - c[0], (data[i + 1] ?? 0) - c[1], (data[i + 2] ?? 0) - c[2]) <= tolerance;
  let mn = 0;
  let mr = 0;
  let mg = 0;
  let mb = 0;
  const seedColour = seed;
  forEachBorder((p) => {
    const i = p * 4;
    if ((data[i + 3] ?? 0) < 200 || !near(i, seedColour)) return;
    mn += 1;
    mr += data[i] ?? 0;
    mg += data[i + 1] ?? 0;
    mb += data[i + 2] ?? 0;
  });
  if (mn === 0) return { removed: 0, reference: null };
  const ref: [number, number, number] = [mr / mn, mg / mn, mb / mn];
  let plain = 0;
  forEachBorder((p) => {
    const i = p * 4;
    if ((data[i + 3] ?? 0) >= 200 && near(i, ref)) plain += 1;
  });
  const borderTotal = 2 * width + 2 * (height - 2);
  if (plain < borderTotal * PLAIN_BORDER_SHARE) return { removed: 0, reference: null };
  const distance = (i: number) =>
    Math.hypot((data[i] ?? 0) - ref[0], (data[i + 1] ?? 0) - ref[1], (data[i + 2] ?? 0) - ref[2]);
  const isBackground = (p: number) => {
    const i = p * 4;
    return (data[i + 3] ?? 0) >= 200 && distance(i) <= tolerance;
  };

  const mask = new Uint8Array(count);
  const queue = new Int32Array(count);
  let head = 0;
  let tail = 0;
  forEachBorder((p) => {
    if (!mask[p] && isBackground(p)) {
      mask[p] = 1;
      queue[tail++] = p;
    }
  });
  while (head < tail) {
    const p = queue[head++] ?? 0;
    const x = p % width;
    const y = (p - x) / width;
    const visit = (q: number) => {
      if (!mask[q] && isBackground(q)) {
        mask[q] = 1;
        queue[tail++] = q;
      }
    };
    if (x > 0) visit(p - 1);
    if (x < width - 1) visit(p + 1);
    if (y > 0) visit(p - width);
    if (y < height - 1) visit(p + width);
  }
  if (tail === 0) return { removed: 0, reference: null };

  // Soften the edge before clearing, so every distance below is read from original colours.
  // 4.5× reaches the antialiased pixel between a white background and a dark rim (Coastal
  // Grill's is #92B1B4, ~154 from white); at 3.5× it stayed an opaque pale ring.
  const feather = tolerance * 4.5;
  for (let p = 0; p < count; p++) {
    if (mask[p]) continue;
    const x = p % width;
    const y = (p - x) / width;
    const touches =
      (x > 0 && mask[p - 1]) ||
      (x < width - 1 && mask[p + 1]) ||
      (y > 0 && mask[p - width]) ||
      (y < height - 1 && mask[p + width]);
    if (!touches) continue;
    const i = p * 4;
    const d = distance(i);
    if (d >= feather) continue;
    const a = Math.min(1, Math.max(0, (d - tolerance) / (feather - tolerance)));
    if (a <= 0.02) {
      data[i + 3] = 0;
      continue;
    }
    for (let c = 0; c < 3; c++) {
      const v = ((data[i + c] ?? 0) - ref[c]! * (1 - a)) / a;
      data[i + c] = Math.min(255, Math.max(0, Math.round(v)));
    }
    data[i + 3] = Math.round((data[i + 3] ?? 255) * a);
  }

  let removed = 0;
  for (let p = 0; p < count; p++) {
    if (!mask[p]) continue;
    data[p * 4 + 3] = 0;
    removed += 1;
  }
  return { removed, reference: toHex(ref[0], ref[1], ref[2]) };
}

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
