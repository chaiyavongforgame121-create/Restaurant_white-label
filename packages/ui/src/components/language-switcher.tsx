'use client';

// Picks the interface language for one app. Menu items, ingredients and restaurant names are
// merchant content and stay as entered whatever is chosen here.
//
// The choice lives in a cookie the app's i18n request config reads (one name per app, see
// UI_LOCALE_COOKIE). Each app passes onChange={() => router.refresh()}: the server re-renders every
// layout and page with the new messages while client state survives, so a rung-up till, a kitchen
// board's timers or an invite link's one-time tokens are not thrown away. Without onChange the page
// reloads, which is only safe on screens that hold nothing in memory.

import * as React from 'react';
import { Languages } from 'lucide-react';
import { UI_LOCALES, UI_LOCALE_NAMES, isUiLocale, type UiLocale } from '@favornoms/shared';
import { cn } from '../lib/cn';
import { useUiLocale, useUiStrings } from './ui-strings';

export type LocaleCode = UiLocale;

export interface LanguageSwitcherProps {
  /** The app's cookie name (UI_LOCALE_COOKIE.web / .admin / .driver). */
  cookieName: string;
  /** Defaults to the locale from the nearest UiLocaleProvider. */
  value?: UiLocale;
  className?: string;
  /** Icon-sized trigger for tight headers; the full name is still in the list. */
  compact?: boolean;
  /** Called after the cookie is written, instead of reloading the page. */
  onChange?: (next: UiLocale) => void;
  /** True while the app is re-rendering in the new language. */
  pending?: boolean;
}

export function LanguageSwitcher({ cookieName, value, className, compact = false, onChange, pending = false }: LanguageSwitcherProps) {
  const contextLocale = useUiLocale();
  const strings = useUiStrings();
  const settled = value ?? contextLocale;
  // Shows the new choice while the refresh is on its way; dropped once the app reports it.
  const [chosen, setChosen] = React.useState<UiLocale | null>(null);
  React.useEffect(() => setChosen(null), [settled]);
  const current = chosen ?? settled;

  const choose = (next: string) => {
    if (!isUiLocale(next) || next === current) return;
    document.cookie = `${cookieName}=${next}; path=/; max-age=${60 * 60 * 24 * 365}; samesite=lax`;
    if (!onChange) {
      window.location.reload();
      return;
    }
    setChosen(next);
    onChange(next);
  };

  return (
    <label
      className={cn(
        'relative inline-flex items-center gap-2 rounded-full border border-border bg-card text-sm font-medium text-foreground',
        compact ? 'h-9 w-9 justify-center' : 'h-9 px-3',
        pending && 'opacity-60',
        className,
      )}
      aria-busy={pending || undefined}
    >
      <Languages className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      {!compact && <span className="truncate">{UI_LOCALE_NAMES[current]}</span>}
      {/* The native select stays on top, invisible, so the OS list (and a screen reader) does the
          choosing on every device, including the kitchen tablet. */}
      <select
        aria-label={strings.language}
        value={current}
        onChange={(e) => choose(e.target.value)}
        className="absolute inset-0 cursor-pointer opacity-0"
      >
        {UI_LOCALES.map((code) => (
          <option key={code} value={code} lang={code}>
            {UI_LOCALE_NAMES[code]}
          </option>
        ))}
      </select>
    </label>
  );
}
