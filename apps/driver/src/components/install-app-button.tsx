'use client';

import * as React from 'react';
import { Download, Share } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useInstallAvailability } from './install-prompt';

/**
 * Explicit "Install the app" entry point — the always-there counterpart to the
 * auto <DriverInstallPrompt> banner. Deliberately ignores the session dismissal:
 * this one is rider-initiated, so it stays available after the banner has been
 * waved away.
 *
 * `as="li"` (the default) drops straight into the profile menu <ul>; `as="div"`
 * is for a standalone section such as the home screen, where a bare <li> would
 * be invalid. Renders nothing at all when there is no install to offer.
 */
export function DriverInstallRow({ as = 'li' }: { as?: 'li' | 'div' }) {
  const { canInstall, isIosSafari, isStandalone, install } = useInstallAvailability();
  const t = useTranslations('install');
  const [hintOpen, setHintOpen] = React.useState(false);

  // Nothing to offer: already installed, or a browser with no install path.
  if (isStandalone || (!canInstall && !isIosSafari)) return null;

  const onClick = async () => {
    // iOS has no install event — all we can do is show the A2HS steps.
    if (!canInstall) {
      setHintOpen((open) => !open);
      return;
    }
    await install();
  };

  const content = (
    <>
      <button
        onClick={onClick}
        aria-expanded={canInstall ? undefined : hintOpen}
        className="focus-ring border-border/60 bg-card hover:shadow-soft flex w-full items-center gap-3 rounded-2xl border p-4 text-left transition-shadow"
      >
        <div className="bg-primary/10 text-primary grid h-10 w-10 shrink-0 place-items-center rounded-xl">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">{t('rowTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('rowSubtitle')}</p>
        </div>
      </button>
      {hintOpen && (
        <p className="text-muted-foreground mt-2 flex flex-wrap items-center gap-1 px-4 text-xs">
          <Share className="h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('iosHint')}
        </p>
      )}
    </>
  );

  return as === 'li' ? <li>{content}</li> : <div>{content}</div>;
}
