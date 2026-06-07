'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Share, X } from 'lucide-react';

const DISMISS_COOKIE = 'a2hs_dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export function InstallPrompt() {
  const [visible, setVisible] = React.useState(false);
  const [iosHint, setIosHint] = React.useState(false);
  const deferred = React.useRef<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
    const dismissed = document.cookie.includes(`${DISMISS_COOKIE}=1`);
    if (dismissed) return;

    // Don't show if already installed (standalone display mode).
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (window.navigator as Navigator & { standalone?: boolean }).standalone === true;
    if (standalone) return;

    // Chrome / Edge / Android Chrome: catch beforeinstallprompt.
    const handler = (e: Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      // Delay to avoid stepping on first-visit cookie banner.
      setTimeout(() => setVisible(true), 8000);
    };
    window.addEventListener('beforeinstallprompt', handler);

    // iOS Safari has no install event — detect + show A2HS instructions.
    const ua = navigator.userAgent;
    const isIosSafari = /iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS/i.test(ua);
    if (isIosSafari) {
      setTimeout(() => {
        setIosHint(true);
        setVisible(true);
      }, 8000);
    }

    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const install = async () => {
    if (deferred.current) {
      await deferred.current.prompt();
      const choice = await deferred.current.userChoice;
      if (choice.outcome === 'accepted') {
        setVisible(false);
      }
      deferred.current = null;
    }
  };

  const dismiss = () => {
    document.cookie = `${DISMISS_COOKIE}=1; max-age=${60 * 60 * 24 * 90}; path=/; SameSite=Lax`;
    setVisible(false);
  };

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className="fixed inset-x-3 bottom-20 z-40 rounded-2xl border border-border bg-card/95 p-4 shadow-warm backdrop-blur-xl sm:bottom-4 sm:left-auto sm:right-4 sm:max-w-sm"
          role="dialog"
        >
          <button
            onClick={dismiss}
            aria-label="Dismiss"
            className="focus-ring absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3 pr-7">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-warm text-white">
              <Download className="h-5 w-5" />
            </span>
            <div className="flex-1">
              <p className="font-display text-sm font-semibold">Install Favornoms</p>
              {iosHint ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Tap <Share className="inline h-3.5 w-3.5 align-text-bottom" /> in Safari, then{' '}
                  <strong>Add to Home Screen</strong> for one-tap reordering.
                </p>
              ) : (
                <p className="mt-1 text-xs text-muted-foreground">
                  Add to your home screen for faster reordering and order notifications.
                </p>
              )}
              {!iosHint && (
                <button
                  onClick={install}
                  className="focus-ring mt-2 inline-flex h-8 items-center rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  Install
                </button>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
