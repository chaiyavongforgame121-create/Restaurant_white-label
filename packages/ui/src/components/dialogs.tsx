'use client';

import * as React from 'react';
import { Button } from './button';
import { useUiStrings } from './ui-strings';

/**
 * In-app replacements for window.confirm and window.prompt.
 *
 * The back office asked 38 questions through native dialogs. Chrome refuses those outright
 * in a sandboxed frame -- prompt() THROWS "prompt() is not supported" rather than returning
 * null -- and every browser suppresses them once someone ticks "prevent this page from
 * creating additional dialogs", which is one careless click away on a screen that asks
 * three times in a row. A suppressed confirm() returns false, so a delete silently does
 * nothing; a suppressed prompt() throws, so the handler dies mid-way. Neither says anything
 * to the person standing there.
 *
 * These are promise-based on purpose: `if (!(await confirm(...))) return;` has the same
 * shape as the line it replaces, which is what makes converting dozens of call sites a
 * mechanical change rather than a rewrite of each handler.
 */

export interface ConfirmRequest {
  title: string;
  /** The consequence, in a sentence. Skip it when the title already says everything. */
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Paints the confirm button as destructive. Use it for anything that loses data. */
  destructive?: boolean;
}

export interface PromptRequest {
  title: string;
  body?: string;
  /** Starting value, which is also what an untouched field submits. */
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  /** Refuse an empty answer rather than returning one. */
  required?: boolean;
}

export interface AlertRequest {
  title: string;
  body?: string;
  confirmLabel?: string;
}

type Pending =
  | { kind: 'confirm'; req: ConfirmRequest; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; req: PromptRequest; resolve: (value: string | null) => void }
  | { kind: 'alert'; req: AlertRequest; resolve: () => void };

const ConfirmCtx = React.createContext<((req: ConfirmRequest) => Promise<boolean>) | null>(null);
const PromptCtx = React.createContext<((req: PromptRequest) => Promise<string | null>) | null>(null);
const AlertCtx = React.createContext<((req: AlertRequest) => Promise<void>) | null>(null);

/**
 * Asks the question. Resolves false when dismissed, so a caller that only checks the happy
 * path cannot mistake "cancelled" for "confirmed".
 */
export function useConfirm(): (req: ConfirmRequest) => Promise<boolean> {
  const ctx = React.useContext(ConfirmCtx);
  if (!ctx) throw new Error('useConfirm must be used inside <DialogProvider>');
  return ctx;
}

/** Resolves null when cancelled — matching window.prompt, so call sites keep their guard. */
export function usePrompt(): (req: PromptRequest) => Promise<string | null> {
  const ctx = React.useContext(PromptCtx);
  if (!ctx) throw new Error('usePrompt must be used inside <DialogProvider>');
  return ctx;
}

/**
 * Says something and waits for an acknowledgement. One button, no question.
 *
 * Mobile browsers swallow window.alert outright, so a failure reported through it reached
 * nobody -- the click simply did nothing.
 */
export function useAlert(): (req: AlertRequest) => Promise<void> {
  const ctx = React.useContext(AlertCtx);
  if (!ctx) throw new Error('useAlert must be used inside <DialogProvider>');
  return ctx;
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [pending, setPending] = React.useState<Pending | null>(null);
  const [draft, setDraft] = React.useState('');
  const strings = useUiStrings();

  const confirm = React.useCallback(
    (req: ConfirmRequest) =>
      new Promise<boolean>((resolve) => setPending({ kind: 'confirm', req, resolve })),
    [],
  );

  const prompt = React.useCallback(
    (req: PromptRequest) =>
      new Promise<string | null>((resolve) => {
        setDraft(req.defaultValue ?? '');
        setPending({ kind: 'prompt', req, resolve });
      }),
    [],
  );

  const notify = React.useCallback(
    (req: AlertRequest) => new Promise<void>((resolve) => setPending({ kind: 'alert', req, resolve })),
    [],
  );

  const settle = React.useCallback(
    (answer: boolean | string | null) => {
      setPending((curr) => {
        if (!curr) return null;
        if (curr.kind === 'confirm') curr.resolve(answer === true);
        else if (curr.kind === 'alert') curr.resolve();
        else curr.resolve(typeof answer === 'string' ? answer : null);
        return null;
      });
    },
    [],
  );

  // Escape always cancels. A question nobody can dismiss is worse than the native dialog
  // this replaces.
  React.useEffect(() => {
    if (!pending) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        settle(pending.kind === 'prompt' ? null : false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, settle]);

  const promptEmpty = pending?.kind === 'prompt' && !!pending.req.required && !draft.trim();

  return (
    <ConfirmCtx.Provider value={confirm}>
      <PromptCtx.Provider value={prompt}>
        <AlertCtx.Provider value={notify}>
        {children}
        {pending && (
          <div
            className="fixed inset-0 z-[100] grid place-items-center bg-black/50 p-4"
            role="dialog"
            aria-modal="true"
            aria-label={pending.req.title}
            onClick={() => settle(pending.kind === 'prompt' ? null : false)}
          >
            <div
              className="bg-card w-full max-w-sm space-y-3 rounded-3xl p-6 shadow-warm"
              onClick={(e) => e.stopPropagation()}
            >
              <h2 className="font-display text-lg font-semibold">{pending.req.title}</h2>
              {pending.req.body && (
                <p className="text-muted-foreground text-sm">{pending.req.body}</p>
              )}

              {pending.kind === 'prompt' && (
                <input
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !promptEmpty) settle(draft);
                  }}
                  autoFocus
                  placeholder={pending.req.placeholder}
                  className="focus-ring border-border bg-background h-12 w-full rounded-xl border px-3 text-base"
                />
              )}

              <div className="flex justify-end gap-2 pt-1">
                {/* An alert is a statement, not a question, so it gets no way to say no. */}
                {pending.kind !== 'alert' && (
                  <Button
                    variant="ghost"
                    onClick={() => settle(pending.kind === 'prompt' ? null : false)}
                  >
                    {(pending.kind === 'confirm' ? pending.req.cancelLabel : undefined) ?? strings.cancel}
                  </Button>
                )}
                <Button
                  variant={
                    pending.kind === 'confirm' && pending.req.destructive ? 'danger' : 'gradient'
                  }
                  disabled={promptEmpty}
                  onClick={() => settle(pending.kind === 'prompt' ? draft : true)}
                >
                  {pending.req.confirmLabel ??
                    (pending.kind === 'prompt'
                      ? strings.save
                      : pending.kind === 'alert'
                        ? strings.ok
                        : strings.confirm)}
                </Button>
              </div>
            </div>
          </div>
        )}
        </AlertCtx.Provider>
      </PromptCtx.Provider>
    </ConfirmCtx.Provider>
  );
}
