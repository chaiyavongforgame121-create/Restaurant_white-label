'use client';

import * as React from 'react';
import { ImagePlus, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';
import {
  DEFAULT_ICON_STYLE,
  ICON_ZOOM_MAX,
  ICON_ZOOM_MIN,
  MASKABLE_VISIBLE_FRACTION,
  clampZoom,
  edgeSwatches,
  iconDrawRect,
  mergeSwatches,
  normalizeIconStyle,
  sameIconStyle,
  type IconFit,
  type IconStyle,
  type IconVariant,
} from './icon-geometry';

export type { IconStyle } from './icon-geometry';

export interface IconSet {
  faviconUrl: string | null;
  icon192Url: string | null;
  icon512Url: string | null;
  iconMaskable512Url: string | null;
}

/** Chrome only offers "Install" when the manifest names an icon of at least 192px whose
 *  declared `sizes` matches the actual bytes. A merchant upload is an arbitrary image, so
 *  we rasterise it ourselves to exact squares rather than declaring a size we cannot honour. */
const SIZES = [192, 512] as const;

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MIN_EDGE = 192;
const MAX_BYTES = 5 * 1024 * 1024;
/** The kept original is re-encoded no larger than this: plenty for a 512 render, small to store. */
const SOURCE_MAX_EDGE = 1024;
const PREVIEW_PX = 128;
const LOAD_FAILED = 'Could not load your current icon. Upload it again to change its style.';
const FITS: readonly IconFit[] = ['fill', 'padded'];

function drawIcon(src: ImageBitmap, size: number, style: IconStyle, variant: IconVariant): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process the image (no canvas support).');

  // iOS renders transparency as black on the home screen, so every variant gets an opaque
  // ground rather than inheriting whatever alpha the merchant uploaded.
  ctx.fillStyle = style.background;
  ctx.fillRect(0, 0, size, size);

  const r = iconDrawRect(src.width, src.height, size, style, variant);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, r.x, r.y, r.w, r.h);
  return canvas;
}

/** The upload itself, transparency kept, capped at SOURCE_MAX_EDGE. */
function drawSource(src: ImageBitmap): HTMLCanvasElement {
  const scale = Math.min(1, SOURCE_MAX_EDGE / Math.max(src.width, src.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(src.width * scale));
  canvas.height = Math.max(1, Math.round(src.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process the image (no canvas support).');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** What an Android launcher shows: the centre MASKABLE_VISIBLE_FRACTION of the maskable tile. */
function drawLauncherView(src: ImageBitmap, style: IconStyle): string {
  const full = Math.round(PREVIEW_PX / MASKABLE_VISIBLE_FRACTION);
  const tile = drawIcon(src, full, style, 'maskable');
  const view = document.createElement('canvas');
  view.width = PREVIEW_PX;
  view.height = PREVIEW_PX;
  const ctx = view.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const offset = (full - PREVIEW_PX) / 2;
  ctx.drawImage(tile, offset, offset, PREVIEW_PX, PREVIEW_PX, 0, 0, PREVIEW_PX, PREVIEW_PX);
  return view.toDataURL('image/png');
}

function toPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the resized icon.'))),
      'image/png',
    );
  });
}

/** A stored image as pixels. Read as a blob first: a bitmap built from fetched bytes does not
 *  taint the canvas it is drawn on. */
async function loadBitmap(url: string): Promise<ImageBitmap> {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(LOAD_FAILED);
  return createImageBitmap(await res.blob());
}

function swatchesOf(src: ImageBitmap): string[] {
  const size = 96;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return [];
  ctx.drawImage(src, 0, 0, size, size);
  try {
    return edgeSwatches(ctx.getImageData(0, 0, size, size).data, size, size);
  } catch {
    return [];
  }
}

/**
 * Uploads one merchant image and derives the full icon set the storefront needs:
 * the favicon (browser tab + iOS home screen) plus exactly-sized 192/512 PNGs and a
 * maskable 512 for the Android home screen.
 *
 * The maskable icon used to be the image shrunk to 62.5% on white, which on a real phone is the
 * logo floating in a thick white frame. It now fills the tile by default, with a zoom and a
 * background picked from the image's own edge, previewed at the crop a launcher really applies.
 * The untouched upload is kept alongside, so the style can be changed later without uploading
 * again. Icons made before that have no original: they can still be zoomed or padded, but their
 * background is part of the image, so the colour choice is withheld where it would do nothing.
 */
export function IconUpload({
  restaurantId,
  value,
  onChange,
  appliedStyle = null,
  onAppliedStyleChange,
  onPendingChange,
}: {
  restaurantId: string;
  value: IconSet;
  onChange: (next: IconSet) => void;
  /** The style the current files were rendered with, as saved. Null when unknown — an icon
   *  made before styles existed, which is always the old padded one. */
  appliedStyle?: IconStyle | null;
  /** Called whenever new files are rendered, so the caller can save the style with them. */
  onAppliedStyleChange?: (style: IconStyle | null) => void;
  /** True while the merchant has changed the style but not applied it — Save would drop it. */
  onPendingChange?: (pending: boolean) => void;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const fitRefs = React.useRef<Record<IconFit, HTMLButtonElement | null>>({ fill: null, padded: null });
  const fitLabelId = React.useId();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState<IconStyle>(() => normalizeIconStyle(appliedStyle ?? DEFAULT_ICON_STYLE));
  const [applied, setApplied] = React.useState<IconStyle | null>(appliedStyle);
  const [sourceUrl, setSourceUrl] = React.useState<string | null>(appliedStyle?.sourceUrl ?? null);
  const [source, setSource] = React.useState<ImageBitmap | null>(null);
  /** 'original' can be recoloured; 'flattened' is a rendered 512 with its background baked in. */
  const [sourceKind, setSourceKind] = React.useState<'original' | 'flattened' | null>(null);
  const [touched, setTouched] = React.useState(false);
  const [swatches, setSwatches] = React.useState<string[]>([]);
  const [previews, setPreviews] = React.useState<{ android: string; iphone: string } | null>(null);

  const currentUrl = value.icon512Url ?? value.icon192Url;

  // Load something to restyle and preview from: the kept original when there is one, else the
  // rendered 512.
  React.useEffect(() => {
    if (source || !currentUrl) return;
    let cancelled = false;
    void (async () => {
      if (sourceUrl) {
        try {
          const bmp = await loadBitmap(sourceUrl);
          if (!cancelled) {
            setSource(bmp);
            setSourceKind('original');
          }
          return;
        } catch {
          /* fall through to the rendered icon */
        }
      }
      try {
        const bmp = await loadBitmap(currentUrl);
        if (!cancelled) {
          setSource(bmp);
          setSourceKind('flattened');
        }
      } catch {
        if (!cancelled) setError(LOAD_FAILED);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentUrl, source, sourceUrl]);

  React.useEffect(() => {
    setSwatches(source ? swatchesOf(source) : []);
  }, [source]);

  // A flattened source in fill mode covers the whole tile with its own baked-in background, so a
  // different colour would change nothing but the saved style. Keep the colour it already has.
  const canRecolour = sourceKind === 'original' || draft.fit === 'padded';
  const effective = React.useMemo<IconStyle>(
    () =>
      normalizeIconStyle(
        canRecolour ? draft : { ...draft, background: applied?.background ?? DEFAULT_ICON_STYLE.background },
      ),
    [draft, canRecolour, applied],
  );

  React.useEffect(() => {
    if (!source) {
      setPreviews(null);
      return;
    }
    try {
      setPreviews({
        android: drawLauncherView(source, effective),
        iphone: drawIcon(source, PREVIEW_PX, effective, 'any').toDataURL('image/png'),
      });
    } catch {
      setPreviews(null);
    }
  }, [source, effective]);

  const stale = !!currentUrl && !sameIconStyle(applied, effective);
  const pending = touched && stale;
  React.useEffect(() => {
    onPendingChange?.(pending);
  }, [pending, onPendingChange]);

  const edit = (fn: (d: IconStyle) => IconStyle) => {
    setTouched(true);
    setDraft(fn);
  };

  const renderAndUpload = async (src: ImageBitmap, style: IconStyle, keepOriginal: boolean) => {
    const supabase = getBrowserClient();
    const stamp = crypto.randomUUID();
    const put = async (blob: Blob, name: string) => {
      const path = `${restaurantId}/${name}-${stamp}.png`;
      const { error: upErr } = await supabase.storage
        .from('branding')
        .upload(path, blob, { upsert: true, cacheControl: '3600', contentType: 'image/png' });
      if (upErr) throw new Error(upErr.message);
      return supabase.storage.from('branding').getPublicUrl(path).data.publicUrl;
    };

    // Uploaded in parallel — sequential round trips are a visible stall on a café's uplink.
    const [b192, b512, bMask, bSource] = await Promise.all([
      toPng(drawIcon(src, SIZES[0], style, 'any')),
      toPng(drawIcon(src, SIZES[1], style, 'any')),
      toPng(drawIcon(src, SIZES[1], style, 'maskable')),
      keepOriginal ? toPng(drawSource(src)) : Promise.resolve(null),
    ]);
    const [icon192Url, icon512Url, iconMaskable512Url, newSourceUrl] = await Promise.all([
      put(b192, 'icon-192'),
      put(b512, 'icon-512'),
      put(bMask, 'icon-maskable-512'),
      bSource ? put(bSource, 'icon-source') : Promise.resolve(sourceUrl),
    ]);

    const saved = normalizeIconStyle({ ...style, ...(newSourceUrl ? { sourceUrl: newSourceUrl } : {}) });
    // The favicon points at the 192 so the tab icon and the installed icon can never
    // drift apart — they were two independent uploads before.
    onChange({ faviconUrl: icon192Url, icon192Url, icon512Url, iconMaskable512Url });
    setSourceUrl(newSourceUrl ?? null);
    setApplied(saved);
    setTouched(false);
    onAppliedStyleChange?.(saved);
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      if (!ACCEPTED.includes(file.type)) {
        throw new Error('Use a PNG, JPEG or WebP image. SVG cannot be used as an app icon.');
      }
      if (file.size > MAX_BYTES) throw new Error('That image is larger than 5 MB.');

      // createImageBitmap gives the true pixel dimensions; the file name and the declared
      // MIME both lie often enough that neither can gate installability.
      const bmp = await createImageBitmap(file);
      if (Math.min(bmp.width, bmp.height) < MIN_EDGE) {
        throw new Error(
          `That image is ${bmp.width}×${bmp.height}. App icons need at least ${MIN_EDGE}×${MIN_EDGE} — a smaller one makes the install button disappear.`,
        );
      }
      // A fresh original can take any colour, so render the draft as chosen, not as pinned.
      await renderAndUpload(bmp, normalizeIconStyle(draft), true);
      setSource(bmp);
      setSourceKind('original');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const apply = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      await renderAndUpload(source, effective, false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = () => {
    onChange({ faviconUrl: null, icon192Url: null, icon512Url: null, iconMaskable512Url: null });
    setSource(null);
    setSourceKind(null);
    setSourceUrl(null);
    setApplied(null);
    setTouched(false);
    setError(null);
    onAppliedStyleChange?.(null);
  };

  const onFitKey = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = FITS[(index + step + FITS.length) % FITS.length] ?? 'fill';
    edit((d) => ({ ...d, fit: next }));
    fitRefs.current[next]?.focus();
  };

  const thumb = value.icon192Url ?? value.faviconUrl;
  const palette = mergeSwatches(swatches, ['#FFFFFF', '#000000']);

  return (
    <div>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED.join(',')}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
      <div className="flex items-center gap-3">
        {thumb ? (
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-border bg-muted/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={thumb} alt="" className="h-full w-full object-cover" />
            {/* Disabled mid-render: a finished upload would otherwise bring the icon back. */}
            <button
              type="button"
              onClick={clear}
              disabled={busy}
              className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white disabled:opacity-40"
              aria-label="Remove icon"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
            className="grid h-20 w-20 shrink-0 place-items-center rounded-2xl border border-dashed border-border bg-muted/30 text-muted-foreground transition hover:border-primary"
          >
            <ImagePlus className="h-6 w-6" />
          </button>
        )}
        <div className="min-w-0">
          <p className="text-sm text-muted-foreground">
            Square PNG, JPEG or WebP, at least 192×192. A PNG with a transparent background gives
            you the most choice. We resize it into every size the browser and the installed app need.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Processing…' : thumb ? 'Replace icon' : 'Choose icon'}
          </Button>
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}

      {currentUrl && source && (
        <div className="mt-4 space-y-3 rounded-2xl border border-border bg-muted/20 p-3">
          <div>
            <span id={fitLabelId} className="mb-1.5 block text-xs font-medium">
              Android home-screen icon
            </span>
            <div
              role="radiogroup"
              aria-labelledby={fitLabelId}
              className="inline-flex rounded-xl border border-border bg-background p-0.5"
            >
              {FITS.map((fit, i) => (
                <button
                  key={fit}
                  ref={(el) => {
                    fitRefs.current[fit] = el;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={draft.fit === fit}
                  tabIndex={draft.fit === fit ? 0 : -1}
                  onClick={() => edit((d) => ({ ...d, fit }))}
                  onKeyDown={(e) => onFitKey(e, i)}
                  className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    draft.fit === fit
                      ? 'bg-primary text-primary-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {fit === 'fill' ? 'Fill the tile' : 'Keep padding'}
                </button>
              ))}
            </div>
          </div>

          {draft.fit === 'fill' && (
            <label className="block">
              <span className="mb-1 flex justify-between text-xs font-medium">
                <span>Zoom</span>
                <span className="text-muted-foreground">{Math.round(draft.zoom * 100)}%</span>
              </span>
              <input
                type="range"
                min={ICON_ZOOM_MIN * 100}
                max={ICON_ZOOM_MAX * 100}
                step={5}
                value={Math.round(draft.zoom * 100)}
                onChange={(e) => edit((d) => ({ ...d, zoom: clampZoom(Number(e.target.value) / 100) }))}
                className="w-full"
                style={{ accentColor: 'hsl(var(--primary))' }}
              />
              <span className="mt-0.5 block text-[11px] text-muted-foreground">
                Zoom in until the white around a round logo disappears from the previews.
              </span>
            </label>
          )}

          {canRecolour ? (
            <div>
              <span className="mb-1.5 block text-xs font-medium">
                {draft.fit === 'fill' ? 'Background' : 'Frame colour'}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                {palette.map((hex) => (
                  <button
                    key={hex}
                    type="button"
                    aria-label={`Colour ${hex}`}
                    aria-pressed={draft.background === hex}
                    onClick={() => edit((d) => ({ ...d, background: hex }))}
                    className={`h-7 w-7 rounded-full border border-border ${
                      draft.background === hex ? 'ring-2 ring-primary ring-offset-2 ring-offset-background' : ''
                    }`}
                    style={{ backgroundColor: hex }}
                  />
                ))}
                <input
                  type="color"
                  aria-label="Custom colour"
                  value={draft.background}
                  onChange={(e) => {
                    const hex = e.target.value.toUpperCase();
                    edit((d) => ({ ...d, background: hex }));
                  }}
                  className="h-7 w-9 cursor-pointer rounded border border-border bg-transparent"
                />
              </div>
              <span className="mt-1 block text-[11px] text-muted-foreground">
                {sourceKind === 'original'
                  ? 'The first colours come from the edge of your image — picking the rim colour makes the tile look seamless.'
                  : 'Only the frame around your icon changes colour; the icon keeps the background it was made with.'}
              </span>
            </div>
          ) : (
            <p className="text-[11px] text-muted-foreground">
              This icon&apos;s background is part of the image. To choose a different colour, upload
              your original again — ideally a PNG with a transparent background.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3">
            {previews && (
              <>
                <figure className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previews.android} alt="Android rounded-square preview" className="h-14 w-14 rounded-[28%] shadow-sm" />
                  <figcaption className="mt-1 text-[10px] text-muted-foreground">Android</figcaption>
                </figure>
                <figure className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previews.android} alt="Android circle preview" className="h-14 w-14 rounded-full shadow-sm" />
                  <figcaption className="mt-1 text-[10px] text-muted-foreground">Android</figcaption>
                </figure>
                <figure className="text-center">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={previews.iphone} alt="iPhone preview" className="h-14 w-14 rounded-[22%] shadow-sm" />
                  <figcaption className="mt-1 text-[10px] text-muted-foreground">iPhone</figcaption>
                </figure>
              </>
            )}
            <p className="min-w-[10rem] flex-1 text-[11px] text-muted-foreground">
              Roughly what phones show. Android crops to its own shape; iPhone shows your whole image
              with rounded corners, so zoom does not apply there.
            </p>
          </div>

          {stale && (
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" size="sm" onClick={apply} loading={busy}>
                Apply to icon
              </Button>
              <span className="text-[11px] text-muted-foreground">
                {applied
                  ? 'Then save to publish.'
                  : 'Your current icon still has the old white padding — apply, then save.'}
              </span>
            </div>
          )}
        </div>
      )}

      {value.icon512Url && !stale && (
        <p className="mt-1.5 text-xs text-success">
          Ready — 192, 512 and maskable icons generated.
        </p>
      )}
    </div>
  );
}
