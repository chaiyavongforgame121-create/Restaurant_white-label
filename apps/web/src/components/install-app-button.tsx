'use client';

import * as React from 'react';
import { Download, Share } from 'lucide-react';
import { useApplicationName, useInstallAvailability } from './install-prompt';

/**
 * Explicit "Install app" entry point for the Account menu — the always-there
 * counterpart to the auto <InstallPrompt> banner. Deliberately ignores the
 * session dismissal: this one is user-initiated, so it stays available even
 * after the banner has been waved away.
 *
 * Renders its own <li> to sit directly in the account menu <ul>, and renders
 * nothing at all when there is no install to offer.
 */
export function InstallAppButton() {
  const { canInstall, isIosSafari, isStandalone, install } = useInstallAvailability();
  const appName = useApplicationName();
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

  return (
    <li>
      <button
        onClick={onClick}
        aria-expanded={canInstall ? undefined : hintOpen}
        className="focus-ring flex w-full items-center gap-3 rounded-2xl border border-border/60 bg-card p-4 text-left transition-shadow hover:shadow-soft"
      >
        <div className="grid h-10 w-10 place-items-center rounded-xl bg-primary/10 text-primary">
          <Download className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <p className="font-semibold">Install {appName}</p>
          <p className="text-xs text-muted-foreground">
            Faster reordering and order notifications
          </p>
        </div>
      </button>
      {hintOpen && (
        <p className="mt-2 px-4 text-xs text-muted-foreground">
          Tap <Share className="inline h-3.5 w-3.5 align-text-bottom" /> in Safari, then{' '}
          <strong>Add to Home Screen</strong>.
        </p>
      )}
    </li>
  );
}
