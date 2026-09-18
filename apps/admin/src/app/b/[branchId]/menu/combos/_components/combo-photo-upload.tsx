'use client';

import * as React from 'react';
import { useTranslations } from 'next-intl';
import { ImagePlus, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';
import { errorMessageRef, storageUploadError, type MessageRef } from '@/components/keyed-error';

/** Photo types the branch-assets bucket takes (it also allows SVG, which is no photo of a meal). */
const ACCEPT = 'image/png,image/jpeg,image/webp';

/**
 * A combo's photo, stored with the branch's dish photos: branch-assets/combos/<branchId>/<uuid>.
 *
 * Storage lets only staff who manage that branch's menu write there. The shared ImageUpload writes
 * to the restaurant-wide branding bucket instead, where a manager of one branch could put files in
 * another branch's folder. Same look and messages as ImageUpload, without its logo tools.
 */
export function ComboPhotoUpload({
  branchId,
  value,
  onChange,
  aspect = 'aspect-video',
  label,
}: {
  branchId: string;
  value: string | null;
  onChange: (url: string | null) => void;
  aspect?: string;
  /** Already translated by the caller; defaults to a translated "Upload image". */
  label?: string;
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
      const supabase = getBrowserClient();
      const ext = (file.name.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg';
      const path = `combos/${branchId}/${crypto.randomUUID()}.${ext}`;
      // No upsert: the path is always new, and replacing a file would need UPDATE as well.
      const { error: upErr } = await supabase.storage
        .from('branch-assets')
        .upload(path, file, { upsert: false, cacheControl: '3600', ...(file.type ? { contentType: file.type } : {}) });
      if (upErr) throw storageUploadError(upErr);
      onChange(supabase.storage.from('branch-assets').getPublicUrl(path).data.publicUrl);
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
        accept={ACCEPT}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void upload(f);
          e.target.value = '';
        }}
      />
      {value ? (
        <div className={`relative w-full overflow-hidden rounded-xl border border-border bg-muted/30 ${aspect}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="h-full w-full object-cover" />
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
          className={`flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 text-sm text-muted-foreground transition hover:border-primary ${aspect}`}
        >
          <ImagePlus className="h-6 w-6" />
          {busy ? t('uploading') : (label ?? t('upload'))}
        </button>
      )}
      {value && (
        <div className="mt-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
            {busy ? t('uploading') : t('replace')}
          </Button>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-1 text-xs text-destructive">
          {tRoot(error.key, error.values)}
        </p>
      )}
    </div>
  );
}
