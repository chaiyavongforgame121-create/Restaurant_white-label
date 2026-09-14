'use client';

import * as React from 'react';
import { Check, ChevronDown, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { detectInstallPlatform, type InstallPlatform } from '@favornoms/shared';
import { useInstallAvailability } from './install-prompt';

/** Message key under `install.steps` for each platform. */
const STEP_KEY: Record<InstallPlatform, string> = {
  'ios-safari': 'iosSafari',
  'ios-other-browser': 'iosOtherBrowser',
  'in-app-browser': 'inAppBrowser',
  android: 'android',
  'desktop-chromium': 'desktopChromium',
  'desktop-safari': 'desktopSafari',
  'desktop-firefox': 'desktopFirefox',
  unknown: 'unknown',
};

/**
 * Explicit "Install the app" entry point — the always-there counterpart to the
 * auto <DriverInstallPrompt> banner. Deliberately ignores the session dismissal:
 * this one is rider-initiated, so it stays available after the banner has been
 * waved away.
 *
 * It used to render only when Chrome had handed over a `beforeinstallprompt` event, or on
 * iPhone Safari. Chrome never fires that event once the app is installed on the device, nor in
 * the LINE/Facebook in-app browsers most riders open links in, so the row was usually missing.
 * It now always shows (except inside the installed app itself): with an event it opens the
 * install window, without one it expands the steps for the browser in hand.
 *
 * `as="li"` (the default) drops straight into the profile menu <ul>; `as="div"`
 * is for a standalone section such as the home screen, where a bare <li> would
 * be invalid.
 */
export function DriverInstallRow({ as = 'li' }: { as?: 'li' | 'div' }) {
  const { canInstall, isStandalone, install } = useInstallAvailability();
  const t = useTranslations('install');
  const [open, setOpen] = React.useState(false);
  const [installed, setInstalled] = React.useState(false);
  const [platform, setPlatform] = React.useState<InstallPlatform>('unknown');

  React.useEffect(() => {
    setPlatform(detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints));
    const onInstalled = () => setInstalled(true);
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  // Already running as the installed app: nothing to install.
  if (isStandalone && !installed) return null;

  const onClick = async () => {
    if (installed) return;
    if (canInstall) {
      const outcome = await install();
      if (outcome === 'accepted') setInstalled(true);
      if (outcome !== 'unavailable') return;
    }
    setOpen((v) => !v);
  };

  const subtitle = installed
    ? t('installed')
    : canInstall
      ? t('rowSubtitle')
      : t('rowSubtitleHelp');

  const content = (
    <>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={canInstall || installed ? undefined : open}
        className="focus-ring border-border/60 bg-card hover:shadow-soft flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition-shadow"
      >
        <div className="bg-primary/10 text-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl">
          <Download className="h-5 w-5" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('rowTitle')}</p>
          <p className={`text-xs ${installed ? 'text-success' : 'text-muted-foreground'}`}>{subtitle}</p>
        </div>
        {installed ? (
          <Check className="text-success h-5 w-5 shrink-0" aria-hidden />
        ) : canInstall ? (
          <span className="bg-primary text-primary-foreground shrink-0 rounded-xl px-3 py-1.5 text-xs font-semibold">
            {t('cta')}
          </span>
        ) : (
          <ChevronDown
            className={`text-muted-foreground h-5 w-5 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        )}
      </button>
      {open && !canInstall && !installed && (
        <div className="border-border/60 bg-muted/40 mt-2 rounded-2xl border px-4 py-3 text-sm">
          <p>{t(`steps.${STEP_KEY[platform]}`)}</p>
          <p className="text-muted-foreground mt-1.5 text-xs">{t('alreadyInstalled')}</p>
        </div>
      )}
    </>
  );

  return as === 'li' ? <li>{content}</li> : <div>{content}</div>;
}
