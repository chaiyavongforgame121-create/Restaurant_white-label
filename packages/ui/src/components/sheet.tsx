'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';
import { cn } from '../lib/cn';

interface SheetProps {
  open: boolean;
  onClose: () => void;
  side?: 'bottom' | 'right';
  children: React.ReactNode;
  title?: React.ReactNode;
  className?: string;
  /** Hide the default close button (for full-screen sheets) */
  hideCloseButton?: boolean;
}

// Stack of currently-open sheets so Escape only dismisses the topmost one
// (otherwise a sheet opened over another — e.g. a map picker over a form — would
// close both on a single Escape).
const openSheetStack: symbol[] = [];

export function Sheet({
  open,
  onClose,
  side = 'bottom',
  children,
  title,
  className,
  hideCloseButton,
}: SheetProps) {
  const idRef = React.useRef<symbol | null>(null);
  if (idRef.current === null) idRef.current = Symbol('sheet');

  React.useEffect(() => {
    if (!open) return;
    const original = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = original;
    };
  }, [open]);

  // Register in the open-sheet stack. Deps are [open] only (NOT onClose) so a
  // parent re-render that recreates onClose can't reorder the stack.
  React.useEffect(() => {
    if (!open) return;
    const id = idRef.current!;
    openSheetStack.push(id);
    return () => {
      const i = openSheetStack.lastIndexOf(id);
      if (i >= 0) openSheetStack.splice(i, 1);
    };
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (openSheetStack[openSheetStack.length - 1] !== idRef.current) return; // topmost only
      onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  const isBottom = side === 'bottom';

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[100]" role="dialog" aria-modal="true">
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={onClose}
            className="absolute inset-0 bg-black/55 backdrop-blur-sm"
          />
          <motion.div
            initial={
              isBottom
                ? { y: '100%' }
                : { x: '100%' }
            }
            animate={isBottom ? { y: 0 } : { x: 0 }}
            exit={isBottom ? { y: '100%' } : { x: '100%' }}
            transition={{ type: 'spring', stiffness: 360, damping: 36 }}
            className={cn(
              'absolute bg-card text-card-foreground shadow-2xl',
              isBottom
                ? 'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-3xl flex flex-col'
                : 'inset-y-0 right-0 w-full max-w-md flex flex-col',
              className,
            )}
          >
            {isBottom && (
              <div className="mx-auto mt-2 h-1.5 w-12 rounded-full bg-border/70" aria-hidden />
            )}
            {(title || !hideCloseButton) && (
              <div className="flex items-center justify-between px-5 pt-4 pb-2">
                <div className="font-display text-xl font-semibold">{title}</div>
                {!hideCloseButton && (
                  <button
                    aria-label="Close"
                    onClick={onClose}
                    className="focus-ring inline-flex h-10 w-10 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
                  >
                    <X className="h-5 w-5" />
                  </button>
                )}
              </div>
            )}
            <div className="flex-1 overflow-y-auto">{children}</div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
