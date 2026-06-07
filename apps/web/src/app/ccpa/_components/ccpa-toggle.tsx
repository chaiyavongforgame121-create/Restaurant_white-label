'use client';

import * as React from 'react';

const COOKIE = 'do_not_sell';

export function CcpaToggle() {
  const [optedOut, setOptedOut] = React.useState(false);

  React.useEffect(() => {
    const m = document.cookie.match(/(?:^|;\s*)do_not_sell=([^;]+)/);
    if (m && m[1] === '1') setOptedOut(true);
    // Honor Global Privacy Control browser signal.
    if ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl) {
      setOptedOut(true);
      document.cookie = `${COOKIE}=1; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
    }
  }, []);

  const toggle = () => {
    const next = !optedOut;
    setOptedOut(next);
    document.cookie = next
      ? `${COOKIE}=1; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`
      : `${COOKIE}=0; max-age=${60 * 60 * 24 * 365}; path=/; SameSite=Lax`;
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`focus-ring inline-flex items-center gap-3 rounded-2xl border px-4 py-3 text-sm font-semibold transition ${
        optedOut ? 'border-success bg-success/10 text-success' : 'border-border bg-card'
      }`}
    >
      <span
        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          optedOut ? 'bg-success' : 'bg-muted-foreground/30'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform ${
            optedOut ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </span>
      {optedOut ? 'Opted out of sharing' : 'Opt out of sharing for cross-context advertising'}
    </button>
  );
}
