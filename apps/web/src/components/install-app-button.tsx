'use client';

import * as React from 'react';
import { Check, ChevronDown, Download } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { detectInstallPlatform, type InstallPlatform } from '@favornoms/shared';
import {
  useApplicationIcon,
  useApplicationName,
  useInstallAvailability,
} from './install-prompt';

/**
 * What to do when the browser cannot open its own install window for us — the key of the
 * steps under common.install.steps.
 */
const STEPS: Record<InstallPlatform, string> = {
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
 * "Install app" in the Account menu — the always-there counterpart to the auto <InstallPrompt>
 * banner. Deliberately ignores the session dismissal: this one is diner-initiated.
 *
 * It used to render only when Chrome had handed us a `beforeinstallprompt` event, or on iPhone
 * Safari. Chrome never fires that event once the app is installed on the device, nor in in-app
 * browsers, Firefox or Safari on a computer, so on most devices the row was simply not there.
 * It now always shows (except inside the installed app itself): with an event it opens the
 * browser's install window, without one it expands the steps for the browser in hand.
 *
 * Renders its own <li> to sit directly in the account menu <ul>.
 */
export function InstallAppButton() {
  const t = useTranslations('common');
  const { canInstall, isStandalone, install } = useInstallAvailability();
  const appName = useApplicationName();
  const appIcon = useApplicationIcon();
  const [open, setOpen] = React.useState(false);
  const [installed, setInstalled] = React.useState(false);
  const [platform, setPlatform] = React.useState<InstallPlatform>('unknown');

  React.useEffect(() => {
    setPlatform(detectInstallPlatform(navigator.userAgent, navigator.maxTouchPoints));
    // Also installed from the address bar or the browser menu, not only from this row.
    const onInstalled = () => setInstalled(true);
    window.addEventListener('appinstalled', onInstalled);
    return () => window.removeEventListener('appinstalled', onInstalled);
  }, []);

  // Already running as the installed app: there is nothing to install. `installed` keeps the row
  // on screen when the install happened on this very page, so the diner sees it worked.
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
    ? t('install.installed')
    : canInstall
      ? t('install.benefits')
      : t('install.howTo');

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        aria-expanded={canInstall || installed ? undefined : open}
        className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft"
      >
        {/* The merchant's own icon, so the row looks like the app it installs. */}
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
          <div className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
            <Download className="h-5 w-5" />
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{t('install.title', { name: appName })}</p>
          <p className={`text-xs ${installed ? 'text-success' : 'text-muted-foreground'}`}>{subtitle}</p>
        </div>
        {installed ? (
          <Check className="h-5 w-5 shrink-0 text-success" aria-hidden />
        ) : canInstall ? (
          <span className="shrink-0 rounded-xl bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground">
            {t('install.install')}
          </span>
        ) : (
          <ChevronDown
            className={`h-5 w-5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-180' : ''}`}
            aria-hidden
          />
        )}
      </button>
      {open && !canInstall && !installed && (
        <div className="mt-2 rounded-2xl border border-border/60 bg-muted/40 px-4 py-3 text-sm">
          <p>{t(`install.steps.${STEPS[platform]}`)}</p>
          <p className="mt-1.5 text-xs text-muted-foreground">
            {t('install.alreadyInstalled', { name: appName })}
          </p>
        </div>
      )}
    </li>
  );
}
