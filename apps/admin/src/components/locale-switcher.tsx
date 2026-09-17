'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { LanguageSwitcher, type LanguageSwitcherProps } from '@favornoms/ui';
import { LOCALE_COOKIE } from '@/i18n/config';

/** The language picker wired to this app's cookie. Switching re-renders the server tree in the new
 *  language without a reload, so whatever the screen holds in memory stays put. */
export function LocaleSwitcher(props: Omit<LanguageSwitcherProps, 'cookieName' | 'onChange' | 'pending'>) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <LanguageSwitcher
      {...props}
      cookieName={LOCALE_COOKIE}
      pending={pending}
      onChange={() => startTransition(() => router.refresh())}
    />
  );
}
