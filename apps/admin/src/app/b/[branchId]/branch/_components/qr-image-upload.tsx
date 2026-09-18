'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';
import { KeyedError, errorMessageRef, storageUploadError, type MessageRef } from '@/components/keyed-error';

// The payment QR uploader. Merchants usually upload a phone screenshot of their banking app:
// 1080x2400 or larger, several megabytes, which every diner at checkout and every cashier at the
// counter then downloads. It is scaled here to at most QR_MAX_EDGE on its long side before it
// is stored. That is still several times the size the QR is drawn at, so the code stays sharp
// enough to scan from a screen.

/** Long edge of the stored image. */
const QR_MAX_EDGE = 1200;
/** A file already this small and no larger than QR_MAX_EDGE is stored as it is. */
const KEEP_AS_IS_BYTES = 600 * 1024;

async function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) =>
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new KeyedError('shell.imageUpload.errors.encodeFailed'))),
      type,
      quality,
    ),
  );
}

/**
 * The file to store: the original when it is already small, otherwise a copy at most
 * QR_MAX_EDGE pixels on its long side. A format the browser cannot decode (HEIC outside
 * Safari, SVG) is stored unchanged, as before.
 */
async function shrinkQrImage(file: File): Promise<{ body: Blob; ext: string; contentType?: string }> {
  const originalExt = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
  const original = { body: file as Blob, ext: originalExt };
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    return original;
  }
  try {
    const longEdge = Math.max(bmp.width, bmp.height);
    if (longEdge <= QR_MAX_EDGE && file.size <= KEEP_AS_IS_BYTES) return original;
    const scale = Math.min(1, QR_MAX_EDGE / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bmp.width * scale));
    canvas.height = Math.max(1, Math.round(bmp.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return original;
    // A transparent PNG would turn black in a JPEG; a QR is read dark-on-light.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    // High quality: JPEG artefacts at the module edges are what makes a QR hard to scan.
    const jpeg = await toBlob(canvas, 'image/jpeg', 0.9);
    // Never store something bigger than what was picked.
    if (jpeg.size >= file.size) return original;
    return { body: jpeg, ext: 'jpg', contentType: 'image/jpeg' };
  } finally {
    bmp.close();
  }
}

export function QrImageUpload({
  restaurantId,
  value,
  onChange,
  label,
}: {
  restaurantId: string;
  value: string | null;
  onChange: (url: string | null) => void;
  /** Already translated by the caller. */
  label: string;
}) {
  const t = useTranslations('shell.imageUpload');
  const tRoot = useTranslations();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<MessageRef | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const { body, ext, contentType } = await shrinkQrImage(file);
      const supabase = getBrowserClient();
      // Same bucket and path shape as every other merchant image: "{restaurantId}/{folder}-{uuid}".
      const path = `${restaurantId}/payment-qr-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('branding')
        .upload(path, body, { upsert: false, cacheControl: '3600', ...(contentType ? { contentType } : {}) });
      if (upErr) throw storageUploadError(upErr);
      onChange(supabase.storage.from('branding').getPublicUrl(path).data.publicUrl);
    } catch (e) {
      setError(errorMessageRef(e));
    } finally {
      setBusy(false);
    }
  };

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
        <div className="relative aspect-square w-full overflow-hidden rounded-xl border border-border bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="h-full w-full object-contain" />
          <button
            type="button"
            onClick={() => onChange(null)}
            disabled={busy}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white disabled:opacity-40"
            aria-label={t('remove')}
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex aspect-square w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 text-sm text-muted-foreground transition hover:border-primary"
        >
          <ImagePlus className="h-6 w-6" />
          {busy ? t('uploading') : label}
        </button>
      )}
      {value && (
        <div className="mt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? t('working') : t('replace')}
          </Button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{tRoot(error.key, error.values)}</p>}
    </div>
  );
}
