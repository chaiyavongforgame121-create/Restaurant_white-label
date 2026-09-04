'use client';

import * as React from 'react';
import { Camera, Image as ImageIcon, X } from 'lucide-react';
import { cn } from '../lib/cn';

// Pure presentational chat thread — no supabase/network deps so it stays
// reusable across the web and driver apps (each wires its own data container).
// That holds for photos too: the parent compresses, uploads and inserts; this
// component only takes the File and renders what comes back.

export interface ChatThreadMessage {
  id: string;
  body: string;
  /** True when the current viewer sent this message. */
  mine: boolean;
  created_at: string;
  /** True when the message carries a photo, whether or not its URL has arrived yet. */
  hasImage?: boolean;
  /** Signed URL for the photo. Null while the parent is still signing it. */
  imageUrl?: string | null;
  /** Stored pixel size, used to reserve the bubble so the thread does not jump on decode. */
  imageWidth?: number | null;
  imageHeight?: number | null;
  /** True when the body is only the auto-caption: show the photo alone, not the words. */
  photoOnly?: boolean;
}

interface PendingMessage {
  tempId: number;
  body: string;
  failed: boolean;
  /** Set for a photo send; the retry affordance re-uploads this exact file. */
  file?: File;
  /** Local object URL shown until the real message lands. */
  previewUrl?: string;
}

export interface ChatThreadProps {
  messages: ChatThreadMessage[];
  onSend: (body: string) => void | Promise<void>;
  /** Enables the camera/gallery buttons. The parent owns compress + upload + insert.
   *  Must reject so a failed send gets the same "tap to retry" bubble a text send does. */
  onSendPhoto?: (file: File) => void | Promise<void>;
  /** Human-readable failure from the parent's upload, shown above the composer. */
  photoError?: string | null;
  quickReplies?: string[];
  /** Composer hidden (e.g. delivery completed). */
  disabled?: boolean;
  disabledNotice?: string;
  placeholder?: string;
  className?: string;
}

export function ChatThread({
  messages,
  onSend,
  onSendPhoto,
  photoError,
  quickReplies = [],
  disabled,
  disabledNotice = 'This conversation is closed.',
  placeholder = 'Type a message…',
  className,
}: ChatThreadProps) {
  const [draft, setDraft] = React.useState('');
  // Optimistic outgoing bubbles: shown instantly, removed when the real message
  // lands (via the parent's messages list / realtime), or marked failed on error.
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const [lightbox, setLightbox] = React.useState<string | null>(null);
  const idRef = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const cameraRef = React.useRef<HTMLInputElement>(null);
  const galleryRef = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending.length]);

  // Previews outlive the send when it fails (the bubble stays on screen for the retry),
  // so unmount is the only place left to hand the blobs back.
  const pendingRef = React.useRef(pending);
  pendingRef.current = pending;
  React.useEffect(
    () => () => {
      for (const m of pendingRef.current) if (m.previewUrl) URL.revokeObjectURL(m.previewUrl);
    },
    [],
  );

  const deliver = async (entry: PendingMessage) => {
    try {
      if (entry.file) {
        if (!onSendPhoto) throw new Error('no_photo_handler');
        await onSendPhoto(entry.file);
      } else {
        await onSend(entry.body);
      }
      setPending((p) => p.filter((m) => m.tempId !== entry.tempId));
      if (entry.previewUrl) URL.revokeObjectURL(entry.previewUrl);
    } catch {
      setPending((p) => p.map((m) => (m.tempId === entry.tempId ? { ...m, failed: true } : m)));
    }
  };

  const submit = (text: string) => {
    const body = text.trim();
    if (!body || disabled) return;
    const entry: PendingMessage = { tempId: (idRef.current += 1), body, failed: false };
    setPending((p) => [...p, entry]);
    setDraft('');
    void deliver(entry);
  };

  const submitPhoto = (file: File) => {
    if (disabled || !onSendPhoto) return;
    const entry: PendingMessage = {
      tempId: (idRef.current += 1),
      body: '',
      failed: false,
      file,
      previewUrl: URL.createObjectURL(file),
    };
    setPending((p) => [...p, entry]);
    void deliver(entry);
  };

  const onPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear so re-picking the same file after a failed send still fires onChange.
    e.target.value = '';
    if (file) submitPhoto(file);
  };

  const retry = (entry: PendingMessage) => {
    setPending((p) => p.map((m) => (m.tempId === entry.tempId ? { ...m, failed: false } : m)));
    void deliver({ ...entry, failed: false });
  };

  return (
    <div className={cn('flex h-full min-h-0 flex-col', className)}>
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto px-1 py-3">
        {messages.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No messages yet — say hi 👋
          </p>
        )}
        {messages.map((m) => (
          <div key={m.id} className={cn('flex', m.mine ? 'justify-end' : 'justify-start')}>
            <div
              className={cn(
                'max-w-[80%] rounded-2xl px-3.5 py-2 text-sm leading-snug',
                m.mine
                  ? 'rounded-br-sm bg-primary text-primary-foreground'
                  : 'rounded-bl-sm bg-muted text-foreground',
              )}
            >
              {m.hasImage &&
                (m.imageUrl ? (
                  <img
                    src={m.imageUrl}
                    alt={m.photoOnly ? 'Photo in the conversation' : m.body}
                    loading="lazy"
                    onClick={() => setLightbox(m.imageUrl ?? null)}
                    style={aspectStyle(m.imageWidth, m.imageHeight)}
                    className="mb-1 w-full max-w-[240px] cursor-zoom-in rounded-xl bg-black/10 object-cover"
                  />
                ) : (
                  // The path is known but the signed URL has not landed yet. A sized
                  // placeholder rather than a collapsed bubble that pops the thread open
                  // the moment it resolves.
                  <div
                    aria-hidden
                    style={aspectStyle(m.imageWidth, m.imageHeight)}
                    className="mb-1 w-full max-w-[240px] animate-pulse rounded-xl bg-black/10"
                  />
                ))}
              {!m.photoOnly && <p className="whitespace-pre-wrap break-words">{m.body}</p>}
              <p
                className={cn(
                  'mt-0.5 text-right text-[10px]',
                  m.mine ? 'text-primary-foreground/70' : 'text-muted-foreground',
                )}
              >
                {new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
              </p>
            </div>
          </div>
        ))}
        {pending.map((m) => (
          <div key={`pending-${m.tempId}`} className="flex justify-end">
            <div
              className={cn(
                'max-w-[80%] rounded-2xl rounded-br-sm px-3.5 py-2 text-sm leading-snug',
                m.failed ? 'bg-danger/15 text-danger' : 'bg-primary/60 text-primary-foreground',
              )}
            >
              {m.previewUrl ? (
                <img
                  src={m.previewUrl}
                  alt="Photo being sent"
                  className="mb-1 w-full max-w-[240px] rounded-xl bg-black/10 object-cover opacity-60"
                />
              ) : (
                <p className="whitespace-pre-wrap break-words">{m.body}</p>
              )}
              <p className="mt-0.5 text-right text-[10px]">
                {m.failed ? (
                  <button
                    type="button"
                    onClick={() => retry(m)}
                    className="font-semibold underline"
                  >
                    Not sent — tap to retry
                  </button>
                ) : (
                  <span className="text-primary-foreground/70">Sending…</span>
                )}
              </p>
            </div>
          </div>
        ))}
      </div>

      {disabled ? (
        <p className="border-t border-border px-3 py-3 text-center text-xs text-muted-foreground">
          {disabledNotice}
        </p>
      ) : (
        <div className="border-t border-border pt-2">
          {quickReplies.length > 0 && (
            <div className="flex gap-1.5 overflow-x-auto px-1 pb-2">
              {quickReplies.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => void submit(q)}
                  className="focus-ring shrink-0 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium hover:border-primary/50"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
          {photoError && (
            <p role="alert" className="px-2 pb-1.5 text-xs text-danger">
              {photoError}
            </p>
          )}
          <form
            className="flex items-center gap-2 px-1 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
          >
            {onSendPhoto && (
              <>
                {/* Two inputs, not one: capture="environment" opens the camera straight
                    away on a phone, which is what a rider standing at a gate wants, while
                    the plain input is the only way to reach an existing photo. */}
                <input
                  ref={cameraRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={onPick}
                />
                <input
                  ref={galleryRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPick}
                />
                <button
                  type="button"
                  onClick={() => cameraRef.current?.click()}
                  aria-label="Take a photo"
                  className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:border-primary/50"
                >
                  <Camera className="h-5 w-5" />
                </button>
                <button
                  type="button"
                  onClick={() => galleryRef.current?.click()}
                  aria-label="Choose a photo"
                  className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full border border-border text-muted-foreground hover:border-primary/50"
                >
                  <ImageIcon className="h-5 w-5" />
                </button>
              </>
            )}
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              maxLength={1000}
              className="h-11 min-w-0 flex-1 rounded-full border border-border bg-background px-4 text-sm outline-none transition-colors focus-visible:border-primary"
            />
            <button
              type="submit"
              disabled={!draft.trim()}
              className="focus-ring grid h-11 w-11 shrink-0 place-items-center rounded-full bg-primary text-primary-foreground disabled:opacity-40"
              aria-label="Send"
            >
              ➤
            </button>
          </form>
        </div>
      )}

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}

/** Reserves the bubble before the bytes decode. 4/3 is the fallback for a legacy row that
 *  stored a path but no size. */
function aspectStyle(width?: number | null, height?: number | null): React.CSSProperties {
  return { aspectRatio: width && height ? `${width} / ${height}` : '4 / 3' };
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  React.useEffect(() => {
    // Capture phase, and stopPropagation. The chat renders inside Sheet, which listens for
    // Escape with a bubble-phase window listener; a bubble-phase listener here would not
    // beat it and one press would close the photo AND the whole conversation. Capturing on
    // window runs first and stops the bubble.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Photo"
      onClick={onClose}
      // Above Sheet's own z-[100], or it opens behind the conversation it came from.
      className="fixed inset-0 z-[200] grid place-items-center bg-black/90 p-4"
    >
      <img src={src} alt="" className="max-h-full max-w-full object-contain" />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close photo"
        className="focus-ring absolute right-4 top-4 grid h-11 w-11 place-items-center rounded-full bg-white/15 text-white"
      >
        <X className="h-5 w-5" />
      </button>
    </div>
  );
}
