'use client';

import * as React from 'react';
import { Camera, CheckCircle2, ChevronDown, Image as ImageIcon } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';

type Mode = 'pickup' | 'delivery';

const MODE_COPY: Record<Mode, { prompt: string; success: string; tips: string[] }> = {
  pickup: {
    prompt: '📸 Required — snap a photo of the order at the restaurant before you continue.',
    success: 'Pickup photo uploaded',
    tips: [
      'Show the WHOLE order — every bag and drink in one frame.',
      'Keep the receipt visible so the order number can be checked.',
      'Set it on a flat surface in good light — no blur, nothing cut off.',
    ],
  },
  delivery: {
    prompt: '📸 Required — snap a photo of the delivered order before you finish.',
    success: 'Delivery photo uploaded',
    tips: [
      'Show the food AT the drop-off spot the customer asked for.',
      'Include the door, desk or unit number so the spot is recognizable.',
      'Step back and use good light — no blur, nothing cut off.',
    ],
  },
};

/**
 * Proof-photo uploader shared by the pickup and delivery legs. "Take photo"
 * opens the camera (capture="environment"); "Choose from gallery" opens the
 * picker — same upload + deliveries-row stamp either way, so the mandatory
 * CTA gating upstream is unchanged.
 */
export function PhotoUploader({
  mode,
  deliveryId,
  uploadedUrl,
  onUploaded,
}: {
  mode: Mode;
  deliveryId: string;
  uploadedUrl: string | null;
  onUploaded: (url: string) => void;
}) {
  const [uploading, setUploading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const galleryRef = React.useRef<HTMLInputElement>(null);
  const copy = MODE_COPY[mode];

  const upload = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const supabase = getBrowserClient();
      const path = `${mode === 'pickup' ? 'pickup' : 'pod'}/${deliveryId}/${Date.now()}.jpg`;
      const { error: upErr } = await supabase.storage
        .from('branch-assets')
        .upload(path, file, { contentType: file.type, upsert: false });
      if (upErr) throw upErr;
      const { data: pub } = supabase.storage.from('branch-assets').getPublicUrl(path);
      const now = new Date().toISOString();
      const { error: updErr } = await supabase
        .from('deliveries')
        .update(
          mode === 'pickup'
            ? { pickup_photo_url: pub.publicUrl, pickup_photo_uploaded_at: now }
            : { pod_photo_url: pub.publicUrl, pod_uploaded_at: now },
        )
        .eq('id', deliveryId);
      if (updErr) throw updErr;
      onUploaded(pub.publicUrl);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  };

  const onFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    // Clear so re-picking the same file after a failed upload still fires onChange.
    e.target.value = '';
    if (f) void upload(f);
  };

  return (
    <div className="rounded-2xl border border-dashed border-primary/40 bg-primary/5 p-3">
      <input
        ref={cameraRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onFile}
      />
      <input ref={galleryRef} type="file" accept="image/*" className="hidden" onChange={onFile} />
      {uploadedUrl ? (
        <div className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2 className="h-4 w-4" /> {copy.success}
        </div>
      ) : (
        <>
          <p className="mb-2 text-xs font-medium">{copy.prompt}</p>
          <PhotoGuide mode={mode} />
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => cameraRef.current?.click()}
              disabled={uploading}
              className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-card px-3 py-2 text-sm font-semibold"
            >
              <Camera className="h-4 w-4 shrink-0" /> {uploading ? 'Uploading…' : 'Take photo'}
            </button>
            <button
              type="button"
              onClick={() => galleryRef.current?.click()}
              disabled={uploading}
              className="focus-ring flex flex-1 items-center justify-center gap-1.5 rounded-xl bg-card px-3 py-2 text-sm font-semibold"
            >
              <ImageIcon className="h-4 w-4 shrink-0" /> Choose from gallery
            </button>
          </div>
        </>
      )}
      {error && <p className="mt-2 text-xs text-destructive">{error}</p>}
    </div>
  );
}

function PhotoGuide({ mode }: { mode: Mode }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div className="mb-2">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="focus-ring flex w-full items-center justify-between text-xs font-medium text-primary"
      >
        💡 How to take a good photo
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {mode === 'pickup' ? (
              <>
                <ExampleTile good label="Whole order, good light">
                  <SvgGoodBag />
                </ExampleTile>
                <ExampleTile good label="Receipt visible">
                  <SvgGoodReceipt />
                </ExampleTile>
              </>
            ) : (
              <>
                <ExampleTile good label="At the drop-off spot">
                  <SvgGoodDoor />
                </ExampleTile>
                <ExampleTile good label="Whole order, good light">
                  <SvgGoodBag />
                </ExampleTile>
              </>
            )}
            <ExampleTile good={false} label="Blurry or dark">
              <SvgBadBlurry />
            </ExampleTile>
            <ExampleTile good={false} label="Cut off at the edge">
              <SvgBadCropped />
            </ExampleTile>
          </div>
          <ul className="space-y-1 text-xs text-muted-foreground">
            {MODE_COPY[mode].tips.map((tip) => (
              <li key={tip} className="flex gap-1.5">
                <span>•</span>
                {tip}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function ExampleTile({
  good,
  label,
  children,
}: {
  good: boolean;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <figure>
      <div className="overflow-hidden rounded-xl border border-border">{children}</div>
      <figcaption
        className={`mt-1 text-[11px] font-semibold leading-tight ${good ? 'text-success' : 'text-danger'}`}
      >
        {good ? '✓' : '✗'} {label}
      </figcaption>
    </figure>
  );
}

/* Flat warm-toned example illustrations — inline so the guide costs no image bytes. */

function SvgGoodBag() {
  return (
    <svg viewBox="0 0 96 64" className="block h-auto w-full" aria-hidden="true">
      <rect width="96" height="64" fill="#FFF3E0" />
      <circle cx="78" cy="12" r="6" fill="#FFD54F" />
      <path
        d="M78 21v4M68 15l-3 3M88 15l3 3"
        stroke="#FFD54F"
        strokeWidth="2"
        strokeLinecap="round"
      />
      <rect x="8" y="50" width="80" height="6" rx="2" fill="#D7A86E" />
      <path d="M33 26h24l3 24H30z" fill="#E8A857" />
      <path d="M39 26c0-5 4-8 9.5-8s9.5 3 9.5 8" stroke="#C97F2E" strokeWidth="2.5" fill="none" />
      <rect x="37" y="34" width="16" height="8" rx="2" fill="#FFF8EF" />
    </svg>
  );
}

function SvgGoodReceipt() {
  return (
    <svg viewBox="0 0 96 64" className="block h-auto w-full" aria-hidden="true">
      <rect width="96" height="64" fill="#FFF3E0" />
      <rect x="8" y="50" width="80" height="6" rx="2" fill="#D7A86E" />
      <path d="M25 26h22l3 24H22z" fill="#E8A857" />
      <path d="M30.5 26c0-5 3.7-8 8.5-8s8.5 3 8.5 8" stroke="#C97F2E" strokeWidth="2.5" fill="none" />
      <rect x="58" y="24" width="16" height="26" rx="2" fill="#FFFFFF" stroke="#E0C9A6" />
      <path
        d="M61.5 30h9M61.5 35h9M61.5 40h6.5"
        stroke="#B08954"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function SvgGoodDoor() {
  return (
    <svg viewBox="0 0 96 64" className="block h-auto w-full" aria-hidden="true">
      <rect width="96" height="64" fill="#FFF3E0" />
      <rect x="38" y="6" width="30" height="46" rx="2" fill="#B4713D" />
      <rect x="42" y="11" width="22" height="17" rx="1" fill="#C98A55" />
      <circle cx="64" cy="34" r="2" fill="#FFD54F" />
      <rect x="8" y="52" width="80" height="4" rx="2" fill="#D7A86E" />
      <path d="M20 36h14l2 16H18z" fill="#E8A857" />
      <path d="M23.5 36c0-3.5 2.5-5.5 5.5-5.5s5.5 2 5.5 5.5" stroke="#C97F2E" strokeWidth="2" fill="none" />
    </svg>
  );
}

function SvgBadBlurry() {
  return (
    <svg viewBox="0 0 96 64" className="block h-auto w-full" aria-hidden="true">
      <rect width="96" height="64" fill="#4A3B33" />
      <g filter="url(#pg-blur)" opacity="0.55">
        <path d="M36 24h24l3 26H33z" fill="#E8A857" />
        <path d="M42 24c0-5 4-8 9.5-8s9.5 3 9.5 8" stroke="#C97F2E" strokeWidth="2.5" fill="none" />
      </g>
      <defs>
        <filter id="pg-blur">
          <feGaussianBlur stdDeviation="2.5" />
        </filter>
      </defs>
    </svg>
  );
}

function SvgBadCropped() {
  return (
    <svg viewBox="0 0 96 64" className="block h-auto w-full" aria-hidden="true">
      <rect width="96" height="64" fill="#FFF3E0" />
      <rect x="8" y="50" width="80" height="6" rx="2" fill="#D7A86E" />
      <path d="M74 24h30l3 26H71z" fill="#E8A857" />
      <path d="M81 24c0-5 4-8 10-8s10 3 10 8" stroke="#C97F2E" strokeWidth="2.5" fill="none" />
      <rect
        x="3"
        y="3"
        width="90"
        height="58"
        rx="4"
        fill="none"
        stroke="#C97F2E"
        strokeWidth="1.5"
        strokeDasharray="4 3"
        opacity="0.5"
      />
    </svg>
  );
}
