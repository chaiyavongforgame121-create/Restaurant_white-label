'use client';

import * as React from 'react';
import { ImagePlus, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

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

/** Android maskable icons are cropped to a circle/squircle; the safe zone is the middle
 *  ~80% by width, and 62.5% is the conventional inset that survives every mask shape. */
const MASKABLE_SCALE = 0.625;

const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp'];
const MIN_EDGE = 192;
const MAX_BYTES = 5 * 1024 * 1024;

async function toBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap gives us the true pixel dimensions; the file name and the declared
  // MIME both lie often enough that neither can gate installability.
  return await createImageBitmap(file);
}

function drawSquare(bmp: ImageBitmap, size: number, inset: number, background: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Your browser could not process the image (no canvas support).');

  // iOS renders transparency as black on the home screen, so every variant gets an opaque
  // ground rather than inheriting whatever alpha the merchant uploaded.
  ctx.fillStyle = background;
  ctx.fillRect(0, 0, size, size);

  const target = size * inset;
  const scale = Math.min(target / bmp.width, target / bmp.height);
  const w = bmp.width * scale;
  const h = bmp.height * scale;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode the resized icon.'))),
      'image/png',
    );
  });
}

/**
 * Uploads one merchant image and derives the full icon set the storefront needs:
 * the favicon (browser tab + iOS home screen) plus exactly-sized 192/512 PNGs and a
 * maskable 512 for the Android install prompt.
 */
export function IconUpload({
  restaurantId,
  value,
  onChange,
  background = '#FFFFFF',
}: {
  restaurantId: string;
  value: IconSet;
  onChange: (next: IconSet) => void;
  /** Opaque ground painted behind the mark. Defaults to white. */
  background?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      if (!ACCEPTED.includes(file.type)) {
        throw new Error('Use a PNG, JPEG or WebP image. SVG cannot be used as an app icon.');
      }
      if (file.size > MAX_BYTES) throw new Error('That image is larger than 5 MB.');

      const bmp = await toBitmap(file);
      if (Math.min(bmp.width, bmp.height) < MIN_EDGE) {
        throw new Error(
          `That image is ${bmp.width}×${bmp.height}. App icons need at least ${MIN_EDGE}×${MIN_EDGE} — a smaller one makes the install button disappear.`,
        );
      }

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

      // Full-bleed for `any`, inset for `maskable`. Uploaded in parallel — three sequential
      // round trips is a visible stall on a café's uplink.
      const [b192, b512, bMask] = await Promise.all([
        drawSquare(bmp, SIZES[0], 1, background),
        drawSquare(bmp, SIZES[1], 1, background),
        drawSquare(bmp, SIZES[1], MASKABLE_SCALE, background),
      ]);
      const [icon192Url, icon512Url, iconMaskable512Url] = await Promise.all([
        put(b192, 'icon-192'),
        put(b512, 'icon-512'),
        put(bMask, 'icon-maskable-512'),
      ]);
      bmp.close();

      // The favicon points at the 192 so the tab icon and the installed icon can never
      // drift apart — they were two independent uploads before.
      onChange({ faviconUrl: icon192Url, icon192Url, icon512Url, iconMaskable512Url });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const clear = () =>
    onChange({ faviconUrl: null, icon192Url: null, icon512Url: null, iconMaskable512Url: null });

  const preview = value.icon192Url ?? value.faviconUrl;

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
        {preview ? (
          <div className="relative h-20 w-20 shrink-0 overflow-hidden rounded-2xl border border-border bg-muted/30">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={preview} alt="" className="h-full w-full object-cover" />
            <button
              type="button"
              onClick={clear}
              className="absolute right-1 top-1 rounded-full bg-black/60 p-0.5 text-white"
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
            Square PNG, JPEG or WebP, at least 192×192. We resize it into every size the
            browser and the installed app need.
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1.5"
            onClick={() => inputRef.current?.click()}
            disabled={busy}
          >
            {busy ? 'Processing…' : preview ? 'Replace icon' : 'Choose icon'}
          </Button>
        </div>
      </div>
      {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
      {value.icon512Url && (
        <p className="mt-1.5 text-xs text-success">
          Ready — 192, 512 and maskable icons generated.
        </p>
      )}
    </div>
  );
}
