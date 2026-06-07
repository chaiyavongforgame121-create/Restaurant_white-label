'use client';

import * as React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { X } from 'lucide-react';

const COOKIE = 'cookie_consent';

export function CookieBanner() {
  const [open, setOpen] = React.useState(false);

  React.useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)cookie_consent=([^;]+)/);
    if (!m) setOpen(true);
  }, []);

  const setConsent = (value: 'accept' | 'reject') => {
    document.cookie = `${COOKIE}=${value}; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
    setOpen(false);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ y: 80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 80, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 240, damping: 26 }}
          className="fixed inset-x-3 bottom-3 z-50 rounded-2xl border border-border bg-card/95 p-4 shadow-warm backdrop-blur-xl sm:bottom-4 sm:left-auto sm:right-4 sm:max-w-md"
          role="dialog"
          aria-labelledby="cookie-title"
        >
          <button
            onClick={() => setConsent('reject')}
            aria-label="Reject and close"
            className="focus-ring absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
          <p id="cookie-title" className="pr-7 font-display text-base font-semibold">
            We use cookies
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            We use essential cookies for sign-in and ordering, plus optional analytics to improve
            the product. See our{' '}
            <a className="text-primary underline" href="/privacy">privacy policy</a>.
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => setConsent('accept')}
              className="focus-ring inline-flex h-9 items-center justify-center rounded-xl bg-primary px-4 text-sm font-semibold text-primary-foreground shadow-soft hover:bg-primary/90"
            >
              Accept all
            </button>
            <button
              onClick={() => setConsent('reject')}
              className="focus-ring inline-flex h-9 items-center justify-center rounded-xl border border-border bg-card px-4 text-sm font-semibold hover:bg-muted"
            >
              Essential only
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
