'use client';

import * as React from 'react';
import { Eraser, ImagePlus, Undo2, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';
import { knockOutBackground } from './icon-geometry';

/** A cleaned logo is re-encoded no larger than this — the storefront draws it about 176px wide. */
const CLEAN_MAX_EDGE = 1600;
/** SVG has no fixed pixel size, so it is rasterised at this long edge before cleaning. */
const SVG_RASTER_EDGE = 1200;

/**
 * The storefront's own page grounds (packages/ui globals.css --background, light and .dark).
 * Written out rather than taken from tokens: the admin may itself be dark, and the preview must
 * show the customer's light page even then.
 */
const STOREFRONT_LIGHT = 'hsl(36 50% 98%)';
const STOREFRONT_DARK = 'hsl(20 18% 8%)';
const LIGHT_LUMINANCE = 0.955;
const DARK_LUMINANCE = 0.0068;
/** WCAG contrast below which a logo is hard to pick out of the page it sits on. */
const MIN_LOGO_CONTRAST = 3;

/** Transparency shows as a checkerboard, so a white box around a logo cannot hide on white. */
function checkerboard(ground: string, ink: string): React.CSSProperties {
  return {
    backgroundColor: ground,
    backgroundImage: `repeating-conic-gradient(${ink} 0% 25%, transparent 0% 50%)`,
    backgroundSize: '16px 16px',
  };
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Alpha-weighted mean relative luminance of the visible pixels, or null when there are none. */
function visibleLuminance(data: Uint8ClampedArray): number | null {
  let weight = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = (data[i + 3] ?? 0) / 255;
    if (a < 0.5) continue;
    const l =
      0.2126 * srgbToLinear(data[i] ?? 0) + 0.7152 * srgbToLinear(data[i + 1] ?? 0) + 0.0722 * srgbToLinear(data[i + 2] ?? 0);
    sum += l * a;
    weight += a;
  }
  return weight > 0 ? sum / weight : null;
}

function contrast(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Something a canvas can draw, with its size. createImageBitmap rejects SVG blobs in every major
 * browser, so SVG goes through an <img> on a same-origin blob: URL, which does not taint the canvas.
 */
async function decodeForCanvas(
  blob: Blob,
  url: string,
): Promise<{ src: CanvasImageSource; w: number; h: number; done: () => void }> {
  const isSvg = blob.type === 'image/svg+xml' || /\.svg(?:[?#]|$)/i.test(url);
  if (!isSvg) {
    try {
      const bmp = await createImageBitmap(blob);
      return { src: bmp, w: bmp.width, h: bmp.height, done: () => bmp.close() };
    } catch {
      throw new Error('This image format cannot be processed here. Upload the logo as a PNG or JPEG.');
    }
  }
  const objectUrl = URL.createObjectURL(blob);
  const img = new Image();
  img.src = objectUrl;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(objectUrl);
    throw new Error('Could not read this SVG. Remove the background inside the SVG file, or upload a PNG.');
  }
  const nw = img.naturalWidth || 300;
  const nh = img.naturalHeight || 150;
  const k = SVG_RASTER_EDGE / Math.max(nw, nh);
  return { src: img, w: Math.round(nw * k), h: Math.round(nh * k), done: () => URL.revokeObjectURL(objectUrl) };
}

// Uploads an image to the public "branding" storage bucket under
// "{restaurantId}/{folder}-{uuid}.{ext}" (write-scoped by RLS to the restaurant's
// owner/managers) and returns the public URL via onChange.
export function ImageUpload({
  restaurantId,
  folder,
  value,
  onChange,
  aspect = 'aspect-video',
  label = 'Upload image',
  removeBackground = false,
}: {
  restaurantId: string;
  folder: string;
  value: string | null;
  onChange: (url: string | null) => void;
  aspect?: string;
  label?: string;
  /**
   * Offer "Remove white background": the plain colour around the image (a logo exported on
   * white, typically a JPEG) becomes transparent, saved as a new PNG. Without it the logo sits in
   * a white box on the storefront header — obvious on the dark theme and on any coloured header.
   * The preview then shows the logo on both of the storefront's grounds.
   */
  removeBackground?: boolean;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  /** The URL before the background was removed, for Undo. */
  const [previous, setPrevious] = React.useState<string | null>(null);
  /** A cleaned logo that will be hard to see on one of the storefront's grounds. */
  const [notice, setNotice] = React.useState<string | null>(null);

  const put = async (body: Blob | File, ext: string, contentType?: string) => {
    const supabase = getBrowserClient();
    const path = `${restaurantId}/${folder}-${crypto.randomUUID()}.${ext}`;
    const { error: upErr } = await supabase.storage
      .from('branding')
      .upload(path, body, { upsert: true, cacheControl: '3600', ...(contentType ? { contentType } : {}) });
    if (upErr) throw new Error(upErr.message);
    return supabase.storage.from('branding').getPublicUrl(path).data.publicUrl;
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      onChange(await put(file, ext));
      setPrevious(null);
      setNotice(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clean = async () => {
    if (!value) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(value, { cache: 'no-store' });
      if (!res.ok) throw new Error('Could not load your image.');
      // From a blob, so the canvas is not tainted and its pixels can be read back.
      const { src, w, h, done } = await decodeForCanvas(await res.blob(), value);
      let pixels: ImageData;
      const canvas = document.createElement('canvas');
      try {
        const scale = Math.min(1, CLEAN_MAX_EDGE / Math.max(w, h));
        canvas.width = Math.max(1, Math.round(w * scale));
        canvas.height = Math.max(1, Math.round(h * scale));
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        if (!ctx) throw new Error('Your browser could not process the image (no canvas support).');
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
        pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
        if (knockOutBackground(pixels.data, canvas.width, canvas.height).removed === 0) {
          throw new Error('There is no plain background around this image to remove.');
        }
        ctx.putImageData(pixels, 0, 0);
      } finally {
        done();
      }
      const blob = await new Promise<Blob>((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('Could not encode the image.'))), 'image/png'),
      );
      const url = await put(blob, 'png', 'image/png');

      // Without its box, a dark logo disappears on the dark storefront and a white one on the
      // light storefront. Say so, but keep the result: it is right for the other theme.
      const lum = visibleLuminance(pixels.data);
      if (lum !== null && contrast(lum, DARK_LUMINANCE) < MIN_LOGO_CONTRAST) {
        setNotice('This logo is dark and will be hard to see for customers using dark mode. Undo, or upload a light version.');
      } else if (lum !== null && contrast(lum, LIGHT_LUMINANCE) < MIN_LOGO_CONTRAST) {
        setNotice('This logo is light and will be hard to see on the light storefront. Undo, or upload a darker version.');
      } else {
        setNotice(null);
      }
      setPrevious(value);
      onChange(url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const undo = () => {
    if (!previous) return;
    onChange(previous);
    setPrevious(null);
    setNotice(null);
  };

  const removeButton = (
    <button
      type="button"
      onClick={() => {
        onChange(null);
        setPrevious(null);
        setNotice(null);
      }}
      disabled={busy}
      className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white disabled:opacity-40"
      aria-label="Remove image"
    >
      <X className="h-4 w-4" />
    </button>
  );

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
      {value ? (
        removeBackground ? (
          <div className={`relative grid w-full grid-cols-2 overflow-hidden rounded-xl border border-border ${aspect}`}>
            <div className="relative" style={checkerboard(STOREFRONT_LIGHT, 'rgb(0 0 0 / 0.05)')}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={value} alt="Logo on the light storefront" className="h-full w-full object-contain p-2" />
              <span className="absolute bottom-1 left-2 text-[10px] font-medium text-neutral-500">Light</span>
            </div>
            <div className="relative" style={checkerboard(STOREFRONT_DARK, 'rgb(255 255 255 / 0.05)')}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={value} alt="Logo on the dark storefront" className="h-full w-full object-contain p-2" />
              <span className="absolute bottom-1 left-2 text-[10px] font-medium text-neutral-400">Dark</span>
            </div>
            {removeButton}
          </div>
        ) : (
          <div className={`relative w-full overflow-hidden rounded-xl border border-border bg-muted/30 ${aspect}`}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={value} alt="" className="h-full w-full object-contain" />
            {removeButton}
          </div>
        )
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 text-sm text-muted-foreground transition hover:border-primary ${aspect}`}
        >
          <ImagePlus className="h-6 w-6" />
          {busy ? 'Uploading…' : label}
        </button>
      )}
      {value && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Working…' : 'Replace image'}
          </Button>
          {removeBackground &&
            (previous ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={undo}
                disabled={busy}
                leftIcon={<Undo2 className="h-4 w-4" />}
              >
                Undo background removal
              </Button>
            ) : (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={clean}
                disabled={busy}
                leftIcon={<Eraser className="h-4 w-4" />}
              >
                Remove white background
              </Button>
            ))}
        </div>
      )}
      {notice && <p className="mt-1 text-xs text-warning">{notice}</p>}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
