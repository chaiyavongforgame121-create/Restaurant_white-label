'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, Share, X } from 'lucide-react';
import { useTranslations } from 'next-intl';

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
    /**
     * The document's manifest link (resolved `href`) at the moment __bipEvent was stashed, set by
     * the same script. Undefined only on HTML rendered before the script recorded it.
     */
    __bipManifest?: string | null;
  }
}

export interface InstallAvailability {
  /**
   * A `beforeinstallprompt` event is in hand for the app this page currently links — `install()`
   * opens Chrome's dialog.
   */
  canInstall: boolean;
  /** iOS Safari: no install event exists, only manual Share › Add to Home Screen. */
  isIosSafari: boolean;
  /** Already launched as an installed app — never offer install UI. */
  isStandalone: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

/** The manifest the document links right now, as an absolute URL, or null. */
function readManifestHref(): string | null {
  return document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href || null;
}

function readApplicationName(): string {
  return (
    document.querySelector('meta[name="application-name"]')?.getAttribute('content')?.trim() ||
    PLATFORM_NAME
  );
}

function readApplicationIcon(): string | null {
  // The 192 first: it is the icon the merchant sees as "only my image", while the Apple one is
  // the opaque iPhone copy. Older pages without a sized 192 still have the Apple link.
  const el =
    document.querySelector('link[rel="icon"][sizes="192x192"]') ??
    document.querySelector('link[rel="apple-touch-icon"]');
  const href = el?.getAttribute('href')?.trim();
  // A tenant with no upload falls back to the platform icon in the root layout, and the
  // glyph is a better answer than the platform's mark on a merchant's card.
  return href && !href.startsWith('/icon') && !href.startsWith('/apple-touch') ? href : null;
}

/**
 * One MutationObserver for every install hook on the page, watching the tags a storefront names
 * itself with: the manifest link, <meta name="application-name"> and the icon links.
 *
 * Re-reading them on a pathname change was not enough. The install UI lives in the ROOT layout,
 * so it survives a client-side move from one branch to another, and Next swaps the branch's
 * metadata in after the URL has already changed (streamed, sometimes into a hidden <div> in the
 * body rather than <head>) — a read on the pathname change caught the branch being left. Watching
 * the document instead re-reads whenever those tags actually change, wherever they are.
 * useSyncExternalStore then re-renders only when the value read is different.
 */
const documentListeners = new Set<() => void>();
let documentObserver: MutationObserver | null = null;

function subscribeToDocumentIdentity(onChange: () => void): () => void {
  documentListeners.add(onChange);
  if (!documentObserver && typeof MutationObserver !== 'undefined') {
    documentObserver = new MutationObserver(() => {
      for (const listener of Array.from(documentListeners)) listener();
    });
    documentObserver.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['href', 'content', 'rel', 'name', 'sizes'],
    });
  }
  return () => {
    documentListeners.delete(onChange);
    if (documentListeners.size === 0 && documentObserver) {
      documentObserver.disconnect();
      documentObserver = null;
    }
  };
}

/** The absolute URL of the manifest the document links, kept current across client navigation. */
export function useManifestHref(): string | null {
  return React.useSyncExternalStore(subscribeToDocumentIdentity, readManifestHref, () => null);
}

interface CapturedPrompt {
  event: BeforeInstallPromptEvent;
  /** The manifest the document linked when Chrome fired the event — the app it would install. */
  manifest: string | null;
}

/**
 * Shared install plumbing for <InstallPrompt> and <InstallAppButton>.
 * Reads the event stashed pre-hydration by layout.tsx *and* keeps listening,
 * since on a first visit Chrome fires it only after the manifest round-trip.
 *
 * An event is only good for the manifest it was fired under. Two branches of one restaurant are
 * two apps on one origin, and the install UI outlives a client-side move between them, so an
 * event captured on Hamburger must not be offered — let alone prompted — on Food Thai Thai. Chrome
 * fires a fresh event when the newly linked manifest is installable, and that one is kept instead.
 */
export function useInstallAvailability(): InstallAvailability {
  const [captured, setCaptured] = React.useState<CapturedPrompt | null>(null);
  const [isIosSafari, setIsIosSafari] = React.useState(false);
  const [isStandalone, setIsStandalone] = React.useState(false);
  const capturedRef = React.useRef<CapturedPrompt | null>(null);
  const manifestHref = useManifestHref();

  const remember = React.useCallback((next: CapturedPrompt | null) => {
    capturedRef.current = next;
    setCaptured(next);
  }, []);

  React.useEffect(() => {
    setIsStandalone(
      window.matchMedia?.('(display-mode: standalone)')?.matches === true ||
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true,
    );

    const ua = navigator.userAgent;
    setIsIosSafari(/iPhone|iPad|iPod/i.test(ua) && /Safari/i.test(ua) && !/CriOS|FxiOS/i.test(ua));

    if (window.__bipEvent) {
      remember({
        event: window.__bipEvent,
        // HTML from before the stash recorded its manifest can only be matched to the page it is.
        manifest: window.__bipManifest === undefined ? readManifestHref() : window.__bipManifest,
      });
    }

    const onPrompt = (e: Event) => {
      e.preventDefault();
      remember({ event: e as BeforeInstallPromptEvent, manifest: readManifestHref() });
    };
    const onInstalled = () => {
      remember(null);
      setIsStandalone(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, [remember]);

  const canInstall = captured !== null && captured.manifest !== null && captured.manifest === manifestHref;

  const install = React.useCallback(async () => {
    const current = capturedRef.current;
    // Checked against the document at the moment of the click, not the last render: the page may
    // have moved to another branch in between.
    if (!current || current.manifest === null || current.manifest !== readManifestHref()) {
      return 'unavailable' as const;
    }
    const clear = () => {
      // A prompt event is single-use; Chrome hands out a fresh one if the page re-qualifies.
      remember(null);
      window.__bipEvent = null;
      window.__bipManifest = null;
    };
    try {
      await current.event.prompt();
      const { outcome } = await current.event.userChoice;
      clear();
      return outcome;
    } catch {
      // Already used, or no longer valid for this page: there is nothing to open.
      clear();
      return 'unavailable' as const;
    }
  }, [remember]);

  return { canInstall, isIosSafari, isStandalone, install };
}

/**
 * The name to put in front of the diner. Install UI is mounted in the ROOT
 * layout, outside the branch <ThemeProvider>, so there is no tenant in React
 * context — but the branch layout already stamps the app's name ("<brand> - <branch>",
 * the manifest's `name`) into the document as <meta name="application-name">. Read that
 * instead of hardcoding the platform brand, which would otherwise leak into every
 * white-labelled storefront. Re-read whenever the document's tags change, so moving to a
 * sibling branch renames the card.
 */
export function useApplicationName(): string {
  return React.useSyncExternalStore(subscribeToDocumentIdentity, readApplicationName, () => PLATFORM_NAME);
}

/**
 * The merchant's own app icon, read the same way the name is.
 *
 * The install card showed a generic download arrow while the merchant's icon sat in the
 * very same document as <link rel="apple-touch-icon">. A card offering to install "Coastal
 * Grill" under a grey arrow does not look like the app it installs, which is the whole of
 * what the merchant is being asked to trust. Each branch has its own icon, so this follows the
 * document too.
 */
export function useApplicationIcon(): string | null {
  return React.useSyncExternalStore(subscribeToDocumentIdentity, readApplicationIcon, () => null);
}

export function InstallPrompt() {
  const t = useTranslations('common');
  const { canInstall, isIosSafari, isStandalone, install } = useInstallAvailability();
  const appName = useApplicationName();
  const appIcon = useApplicationIcon();
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
            aria-label={t('dismiss')}
            className="focus-ring absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-full text-muted-foreground hover:bg-muted"
          >
            <X className="h-4 w-4" />
          </button>
          <div className="flex items-start gap-3 pr-7">
            {appIcon ? (
              // eslint-disable-next-line @next/next/no-img-element -- the href comes from the
              // document's own icon link, which next/image cannot be configured for per tenant.
              <img
                src={appIcon}
                alt=""
                width={40}
                height={40}
                className="h-10 w-10 shrink-0 rounded-xl object-cover"
              />
            ) : (
              <span className="bg-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl text-primary-foreground">
                <Download className="h-5 w-5" />
              </span>
            )}
            <div className="flex-1">
              <p className="font-display text-sm font-semibold">{t('install.title', { name: appName })}</p>
              {isIosSafari && !canInstall ? (
                <p className="mt-1 text-xs text-muted-foreground">
                  {t.rich('install.iosHint', {
                    icon: () => <Share className="inline h-3.5 w-3.5 align-text-bottom" />,
                    strong: (chunks) => <strong>{chunks}</strong>,
                  })}
                </p>
              ) : (
                <>
                  <p className="mt-1 text-xs text-muted-foreground">{t('install.promptBody')}</p>
                  <button
                    onClick={onInstallClick}
                    className="focus-ring mt-2 inline-flex h-8 items-center rounded-xl bg-primary px-3 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                  >
                    {t('install.install')}
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
