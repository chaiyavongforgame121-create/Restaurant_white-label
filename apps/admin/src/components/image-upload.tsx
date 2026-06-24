'use client';

import * as React from 'react';
import { ImagePlus, X } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { Button } from '@favornoms/ui';

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
}: {
  restaurantId: string;
  folder: string;
  value: string | null;
  onChange: (url: string | null) => void;
  aspect?: string;
  label?: string;
}) {
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const ext = (file.name.split('.').pop() || 'png').toLowerCase().replace(/[^a-z0-9]/g, '');
      const path = `${restaurantId}/${folder}-${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await supabase.storage
        .from('branding')
        .upload(path, file, { upsert: true, cacheControl: '3600' });
      if (upErr) throw new Error(upErr.message);
      const { data } = supabase.storage.from('branding').getPublicUrl(path);
      onChange(data.publicUrl);
    } catch (e) {
      setError((e as Error).message);
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
        <div className={`relative w-full overflow-hidden rounded-xl border border-border bg-muted/30 ${aspect}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={value} alt="" className="h-full w-full object-contain" />
          <button
            type="button"
            onClick={() => onChange(null)}
            className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white"
            aria-label="Remove image"
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
          {busy ? 'Uploading…' : label}
        </button>
      )}
      {value && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
        >
          {busy ? 'Uploading…' : 'Replace image'}
        </Button>
      )}
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}
