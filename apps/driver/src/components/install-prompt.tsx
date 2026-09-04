'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Share, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

/** Session-scoped: quiet for the rest of this shift, offered again next sign-in. */
const DISMISS_KEY = 'driver_a2hs_dismissed';
const SHOW_DELAY_MS = 2000;
/** Never interrupt a live run — the rider is riding. */
const NO_PROMPT_ROUTES = /^\/app\/active/;

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

declare global {
  interface Window {
    /** Stashed by the inline <head> script in app/layout.tsx. */
    __bipEvent?: BeforeInstallPromptEvent | null;
  }
}

export interface InstallAvailability {
  /** A `beforeinstallprompt` event is in hand — `install()` opens Chrome's dialog. */
  canInstall: boolean;
  /** iOS Safari: no install event exists, only manual Share › Add to Home Screen. */
  isIosSafari: boolean;
  /** Already launched as an installed app — never offer install UI. */
  isStandalone: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

/**
 * Shared install plumbing for <DriverInstallPrompt> and <DriverInstallRow>.
 * Reads the event stashed pre-hydration by layout.tsx *and* keeps listening,
 * since on a first visit Chrome fires it only after the manifest round-trip.
 */
export function useInstallAvailability(): InstallAvailability {
  const [canInstall, setCanInstall] = React.useState(false);
  const [isIosSafari, setIsIosSafari] = React.useState(false);
  const [isStandalone, setIsStandalone] = React.useState(false);
  const deferred = React.useRef<BeforeInstallPromptEvent | null>(null);

  React.useEffect(() => {
    setIsStandalone(
      window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    );

    const ua = navigator.userAgent;
    setIsIosSafari(/iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS/i.test(ua));

    if (window.__bipEvent) {
      deferred.current = window.__bipEvent;
      setCanInstall(true);
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      deferred.current = e as BeforeInstallPromptEvent;
      setCanInstall(true);
    };
    const onInstalled = () => {
      deferred.current = null;
      setCanInstall(false);
      setIsStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const install = React.useCallback(async () => {
    const event = deferred.current;
    if (!event) return 'unavailable' as const;
    await event.prompt();
    const { outcome } = await event.userChoice;
    // A prompt event is single-use; Chrome hands out a fresh one if the page re-qualifies.
    deferred.current = null;
    window.__bipEvent = null;
    setCanInstall(false);
    return outcome;
  }, []);

  return { canInstall, isIosSafari, isStandalone, install };
}

export function DriverInstallPrompt() {
  const { canInstall, isIosSafari, isStandalone, install } = useInstallAvailability();
  const t = useTranslations('install');
  const pathname = usePathname();
  const [visible, setVisible] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    try {
      if (window.sessionStorage.getItem(DISMISS_KEY) === '1') setDismissed(true);
    } catch {
      /* private mode — prompt simply reappears on the next navigation */
    }
  }, []);

  const onRun = NO_PROMPT_ROUTES.test(pathname ?? '');
  const offerable = !isStandalone && !dismissed && !onRun && (canInstall || isIosSafari);

  React.useEffect(() => {
    if (!offerable) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [offerable]);

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* ignore */
    }
    setDismissed(true);
    setVisible(false);
  };

  // Either outcome closes us: accepted installs the app, dismissed means Chrome
  // will not re-show its dialog anyway, so nagging in-page achieves nothing.
  const onInstallClick = async () => {
    await install();
    dismiss();
  };

  // Clear the tab bar (68px + pb-safe) on /app/*; /login has no tab bar. Same
  // offset the apply screen's floating notice uses.
  const bottom = pathname?.startsWith('/app') ? 'bottom-24' : 'bottom-4';

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className={`fixed inset-x-3 ${bottom} border-border bg-card/95 shadow-warm z-50 rounded-2xl border p-4 backdrop-blur-xl`}
          role="dialog"
        >
          {/* min-h-0 opts out of the app-wide 48px button floor from globals.css —
              a glove-sized close chip would swallow the card. */}
          <button
            onClick={dismiss}
            aria-label={t('dismiss')}
            className="focus-ring text-muted-foreground hover:bg-muted absolute right-2 top-2 grid h-7 min-h-0 w-7 place-items-center rounded-full"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3 pr-7">
            <span className="bg-gradient-warm grid h-10 w-10 shrink-0 place-items-center rounded-xl text-white">
              <Download className="h-5 w-5" />
            </span>
            <div className="flex-1">
              <p className="font-display text-sm font-semibold">{t('title')}</p>
              {isIosSafari && !canInstall ? (
                <p className="text-muted-foreground mt-1 flex flex-wrap items-center gap-1 text-xs">
                  <Share className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  {t('iosHint')}
                </p>
              ) : (
                <>
                  <p className="text-muted-foreground mt-1 text-xs">{t('body')}</p>
                  <button
                    onClick={onInstallClick}
                    className="focus-ring bg-primary text-primary-foreground hover:bg-primary/90 mt-2 inline-flex h-9 min-h-0 items-center rounded-xl px-3 text-xs font-semibold"
                  >
                    {t('cta')}
                  </button>
                </>
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
