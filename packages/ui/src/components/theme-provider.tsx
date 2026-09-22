'use client';

import * as React from 'react';
import type { TenantTheme } from '@favornoms/shared';
import { ThemeVarsContext } from '../lib/theme-vars';

type Mode = 'light' | 'dark';

interface ThemeContextValue {
  theme: TenantTheme;
  mode: Mode;
  setMode: (mode: Mode) => void;
  toggleMode: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  theme: TenantTheme;
  children: React.ReactNode;
  defaultMode?: Mode | 'system';
}

/** Convert a hex color like #FF6B35 to "h s% l%" format used by CSS vars. */
function hexToHsl(hex: string): string | null {
  const clean = hex.replace('#', '').trim();
  if (!/^([0-9a-f]{3}|[0-9a-f]{6})$/i.test(clean)) return null;
  const full = clean.length === 3 ? clean.split('').map((c) => c + c).join('') : clean;
  const r = parseInt(full.slice(0, 2), 16) / 255;
  const g = parseInt(full.slice(2, 4), 16) / 255;
  const b = parseInt(full.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  let h = 0;
  let s = 0;
  const l = (max + min) / 2;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case r:
        h = (g - b) / d + (g < b ? 6 : 0);
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      case b:
        h = (r - g) / d + 4;
        break;
    }
    h *= 60;
  }
  return `${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%`;
}

/**
 * The blocking snippet that decides light vs dark and stamps <html> before the first
 * paint.
 *
 * Deciding it in an effect instead is what gave every dark-mode visitor a full-page
 * white→dark snap on every hard load, in all three apps: globals.css redefines every
 * colour token under `.dark`, so the first painted frame was the light palette and the
 * second was the dark one. Nothing here may throw — localStorage is a hard error in
 * Safari private mode and behind "block all cookies", and a theme is never worth a blank
 * page — hence the belt-and-braces try/catch.
 */
function modeScript(storageKey: string, defaultMode: Mode | 'system'): string {
  const fallback =
    defaultMode === 'system'
      ? '!!(window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)").matches)'
      : String(defaultMode === 'dark');
  return (
    '(function(){try{var s=null;try{s=window.localStorage.getItem(' +
    JSON.stringify(storageKey) +
    ')}catch(e){}var d=s==="dark"||(s!=="light"&&' +
    fallback +
    ');document.documentElement.classList.toggle("dark",d)}catch(e){}})();'
  );
}

/**
 * The mode belongs to the document — it *is* the `.dark` class on <html> — not to any one
 * provider, so it lives outside React. apps/web nests a second, branded ThemeProvider
 * inside the root one; a shared store is what stops the two from fighting over the class
 * and lets useTheme() report the same value from either.
 */
let currentMode: Mode | null = null;
const listeners = new Set<() => void>();

function getSnapshot(): Mode {
  // Must be referentially stable between calls or useSyncExternalStore re-renders forever.
  if (currentMode === null) {
    currentMode =
      typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
        ? 'dark'
        : 'light';
  }
  return currentMode;
}

/**
 * SSR and the hydration pass both render 'light', matching the HTML the server sent, so
 * hydration stays clean. React re-reads the client snapshot once hydration finishes and
 * re-renders the handful of mode-dependent bits (the theme toggle's icon) then. The page
 * itself never flashes, because the class was already correct before the first paint.
 */
function getServerSnapshot(): Mode {
  return 'light';
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function syncMode(next: Mode): void {
  if (currentMode === next) return;
  currentMode = next;
  document.documentElement.classList.toggle('dark', next === 'dark');
  for (const listener of listeners) listener();
}

function resolvePreferredMode(storageKey: string, defaultMode: Mode | 'system'): Mode {
  let saved: string | null = null;
  try {
    saved = window.localStorage.getItem(storageKey);
  } catch {
    /* ignore — blocked storage just means we fall back to the OS preference */
  }
  if (saved === 'light' || saved === 'dark') return saved;
  if (defaultMode !== 'system') return defaultMode;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

interface ThemeProviderExtras {
  storageKey?: string;
}

export function ThemeProvider({
  theme,
  children,
  defaultMode = 'system',
  storageKey = 'favornoms-theme-mode',
}: ThemeProviderProps & ThemeProviderExtras) {
  // A provider that already has one above it is only contributing tenant CSS vars. Only
  // the outermost one emits the pre-paint script and owns the class on <html>.
  const isNested = React.useContext(ThemeContext) !== null;
  const mode = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  const setMode = React.useCallback(
    (m: Mode) => {
      try {
        window.localStorage.setItem(storageKey, m);
      } catch {
        /* ignore — a rejected write only costs the choice on the next load */
      }
      syncMode(m);
    },
    [storageKey],
  );

  // Safety net for the one case the pre-paint script cannot cover: it did not run at all
  // (blocked, or a parse error in an older engine). Normally this agrees with what the
  // script already decided and is a no-op, so it costs nothing and never flashes.
  React.useEffect(() => {
    if (isNested) return;
    syncMode(resolvePreferredMode(storageKey, defaultMode));
  }, [isNested, storageKey, defaultMode]);

  const style = React.useMemo(() => {
    const out: Record<string, string> = {};
    if (theme.primaryColor) {
      const hsl = hexToHsl(theme.primaryColor);
      if (hsl) {
        out['--primary'] = hsl;
        out['--ring'] = hsl;
      }
    }
    if (theme.secondaryColor) {
      const hsl = hexToHsl(theme.secondaryColor);
      if (hsl) out['--secondary'] = hsl;
    }
    if (theme.accentColor) {
      const hsl = hexToHsl(theme.accentColor);
      if (hsl) out['--accent'] = hsl;
    }
    if (theme.backgroundColor) {
      const hsl = hexToHsl(theme.backgroundColor);
      if (hsl) out['--background'] = hsl;
    }
    if (theme.textColor) {
      const hsl = hexToHsl(theme.textColor);
      if (hsl) out['--foreground'] = hsl;
    }
    if (theme.borderRadius) out['--radius'] = theme.borderRadius;
    if (theme.fontFamily) out['--font-sans'] = theme.fontFamily;
    return out;
  }, [theme]);

  // The wrapper below only needs this provider's own variables, because CSS inheritance
  // supplies the outer provider's. A portalled overlay gets no such inheritance, so it is
  // handed the merged set: the root's defaults with the tenant's colours laid over them.
  const inheritedVars = React.useContext(ThemeVarsContext);
  const vars = React.useMemo(() => ({ ...inheritedVars, ...style }), [inheritedVars, style]);

  // A fresh object here re-rendered every useTheme() consumer on every parent render.
  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme,
      mode,
      setMode,
      toggleMode: () => setMode(mode === 'light' ? 'dark' : 'light'),
    }),
    [theme, mode, setMode],
  );

  return (
    <ThemeContext.Provider value={value}>
      {isNested ? null : (
        <script
          suppressHydrationWarning
          dangerouslySetInnerHTML={{ __html: modeScript(storageKey, defaultMode) }}
        />
      )}
      <ThemeVarsContext.Provider value={vars}>
        <div style={style as React.CSSProperties} className="contents">
          {children}
        </div>
      </ThemeVarsContext.Provider>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider />');
  return ctx;
}
