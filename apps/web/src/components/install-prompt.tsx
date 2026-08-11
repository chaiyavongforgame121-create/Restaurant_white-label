'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Share, X } from 'lucide-react';

/**
 * Dismissal is session-scoped: quiet for the rest of this visit, offered again
 * next session. Doubles as the name of the superseded 90-day dismiss *cookie*,
 * which we expire on sight.
 */
const DISMISS_KEY = 'a2hs_dismissed';
const SHOW_DELAY_MS = 2000;
const CONSENT_POLL_MS = 500;
/**
 * Consent only gates *when* we appear, never *whether*. The cookie banner
 * clears solely via Accept all / Essential only / X, so a diner who simply
 * ignores it would otherwise wait forever — never seeing the prompt while a
 * 2 Hz timer ran for the entire session.
 */
const CONSENT_MAX_WAIT_MS = 15_000;
/** Platform fallback, used only where no tenant has branded the document. */
const PLATFORM_NAME = 'Favornoms';
/** Mid-purchase is the wrong moment to ask anyone to install anything. */
const NO_PROMPT_ROUTES = /(?:^|\/)(?:cart|checkout)\/?$/;

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
 * Shared install plumbing for <InstallPrompt> and <InstallAppButton>.
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

/**
 * The name to put in front of the diner. Install UI is mounted in the ROOT
 * layout, outside the branch <ThemeProvider>, so there is no tenant in React
 * context — but the branch layout already stamps the brand into the document as
 * <meta name="application-name">. Read that instead of hardcoding the platform
 * brand, which would otherwise leak into every white-labelled storefront.
 */
export function useApplicationName(): string {
  const pathname = usePathname();
  const [name, setName] = React.useState(PLATFORM_NAME);

  React.useEffect(() => {
    const content = document
      .querySelector('meta[name="application-name"]')
      ?.getAttribute('content')
      ?.trim();
    setName(content || PLATFORM_NAME);
  }, [pathname]);

  return name;
}

export function InstallPrompt() {
  const { canInstall, isIosSafari, isStandalone, install } = useInstallAvailability();
  const appName = useApplicationName();
  const pathname = usePathname();
  const [visible, setVisible] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);

  React.useEffect(() => {
    if (readDismissed()) setDismissed(true);
    expireLegacyCookie();
  }, []);

  // Custom domains serve the same pages from a rewritten root, so the checkout
  // funnel is "/cart" there and "/r/{restaurant}/{branch}/cart" on an apex host.
  const inCheckoutFunnel = NO_PROMPT_ROUTES.test(pathname ?? '');
  const offerable = !isStandalone && !dismissed && !inCheckoutFunnel && (canInstall || isIosSafari);

  React.useEffect(() => {
    if (!offerable) {
      setVisible(false);
      return;
    }
    // The cookie banner occupies the same corner at a higher z-index and shows
    // with no delay of its own, so queue behind it instead of animating in
    // underneath it. Consent is a 1-year cookie — only ever waits once.
    let timer = 0;
    const deadline = Date.now() + CONSENT_MAX_WAIT_MS;
    const tick = () => {
      if (hasCookieConsent() || Date.now() >= deadline) {
        timer = window.setTimeout(() => setVisible(true), SHOW_DELAY_MS);
      } else {
        timer = window.setTimeout(tick, CONSENT_POLL_MS);
      }
    };
    tick();
    // Only ever one timer outstanding, so this cancels the whole chain — on
    // unmount and on every re-run (navigating into the funnel included).
    return () => window.clearTimeout(timer);
  }, [offerable]);

  const dismiss = () => {
    try {
      window.sessionStorage.setItem(DISMISS_KEY, '1');
    } catch {
      /* private mode — prompt simply reappears on the next navigation */
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

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ y: 100, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: 100, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 280, damping: 28 }}
          className="fixed inset-x-3 bottom-20 z-50 rounded-2xl border border-border bg-card/95 p-4 shadow-warm backdrop-blur-xl sm:bottom-4 sm:left-auto sm:right-4 sm:max-w-sm"
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
              <p className="font-display text-sm font-semibold">Install {appName}</p>
              {isIosSafari && !canInstall ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  Tap <Share className="inline h-3.5 w-3.5 align-text-bottom" /> in Safari, then{' '}
                  <strong>Add to Home Screen</strong> for one-tap reordering.
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Add to your home screen for faster reordering and order notifications.
                  </p>
                  <button
                    onClick={onInstallClick}
                    className="focus-ring mt-2 inline-flex h-8 items-center rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    Install
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

function readDismissed(): boolean {
  try {
    return window.sessionStorage.getItem(DISMISS_KEY) === '1';
  } catch {
    return false;
  }
}

function hasCookieConsent(): boolean {
  return /(?:^|;\s*)cookie_consent=/.test(document.cookie);
}

/** Retire the old 90-day dismiss cookie so it stops muting the prompt. */
function expireLegacyCookie(): void {
  if (!document.cookie.includes(`${DISMISS_KEY}=`)) return;
  document.cookie = `${DISMISS_KEY}=; max-age=0; path=/; SameSite=Lax`;
}
