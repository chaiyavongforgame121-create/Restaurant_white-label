'use client';

import * as React from 'react';
import { cn } from '../lib/cn';

// Pure presentational chat thread — no supabase/network deps so it stays
// reusable across the web and driver apps (each wires its own data container).

export interface ChatThreadMessage {
  id: string;
  body: string;
  /** True when the current viewer sent this message. */
  mine: boolean;
  created_at: string;
}

export interface ChatThreadProps {
  messages: ChatThreadMessage[];
  onSend: (body: string) => void | Promise<void>;
  quickReplies?: string[];
  /** Composer hidden (e.g. delivery completed). */
  disabled?: boolean;
  disabledNotice?: string;
  placeholder?: string;
  sending?: boolean;
  className?: string;
}

export function ChatThread({
  messages,
  onSend,
  quickReplies = [],
  disabled,
  disabledNotice = 'This conversation is closed.',
  placeholder = 'Type a message…',
  className,
}: ChatThreadProps) {
  const [draft, setDraft] = React.useState('');
  // Optimistic outgoing bubbles: shown instantly, removed when the real message
  // lands (via the parent's messages list / realtime), or marked failed on error.
  const [pending, setPending] = React.useState<{ tempId: number; body: string; failed: boolean }[]>([]);
  const idRef = React.useRef(0);
  const scrollRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, pending.length]);

  const deliver = async (body: string, tempId: number) => {
    try {
      await onSend(body);
      setPending((p) => p.filter((m) => m.tempId !== tempId));
    } catch {
      setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: true } : m)));
    }
  };

  const submit = (text: string) => {
    const body = text.trim();
    if (!body || disabled) return;
    const tempId = (idRef.current += 1);
    setPending((p) => [...p, { tempId, body, failed: false }]);
    setDraft('');
    void deliver(body, tempId);
  };

  const retry = (tempId: number, body: string) => {
    setPending((p) => p.map((m) => (m.tempId === tempId ? { ...m, failed: false } : m)));
    void deliver(body, tempId);
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
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
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
              <p className="whitespace-pre-wrap break-words">{m.body}</p>
              <p className="mt-0.5 text-right text-[10px]">
                {m.failed ? (
                  <button
                    type="button"
                    onClick={() => retry(m.tempId, m.body)}
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
          <form
            className="flex items-center gap-2 px-1 pb-2"
            onSubmit={(e) => {
              e.preventDefault();
              void submit(draft);
            }}
          >
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={placeholder}
              maxLength={1000}
              className="h-11 flex-1 rounded-full border border-border bg-background px-4 text-sm outline-none transition-colors focus-visible:border-primary"
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
    </div>
  );
}
