'use client';

import * as React from 'react';
import type { TenantTheme } from '@favornoms/shared';

interface ThemeContextValue {
  theme: TenantTheme;
  mode: 'light' | 'dark';
  setMode: (mode: 'light' | 'dark') => void;
  toggleMode: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

interface ThemeProviderProps {
  theme: TenantTheme;
  children: React.ReactNode;
  defaultMode?: 'light' | 'dark' | 'system';
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

interface ThemeProviderExtras {
  storageKey?: string;
}

export function ThemeProvider({
  theme,
  children,
  defaultMode = 'system',
  storageKey = 'favornoms-theme-mode',
}: ThemeProviderProps & ThemeProviderExtras) {
  const [mode, setModeState] = React.useState<'light' | 'dark'>('light');

  // Initialize after mount so SSR and client agree (avoids hydration mismatch).
  React.useEffect(() => {
    if (typeof window === 'undefined') return;
    let saved: string | null = null;
    try { saved = window.localStorage.getItem(storageKey); } catch { /* ignore */ }
    if (saved === 'light' || saved === 'dark') {
      setModeState(saved);
      return;
    }
    const initial =
      defaultMode === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : defaultMode;
    setModeState(initial);
  }, [defaultMode, storageKey]);

  const setMode = React.useCallback(
    (m: 'light' | 'dark') => {
      setModeState(m);
      try { window.localStorage.setItem(storageKey, m); } catch { /* ignore */ }
    },
    [storageKey],
  );

  React.useEffect(() => {
    document.documentElement.classList.toggle('dark', mode === 'dark');
  }, [mode]);

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

  const value: ThemeContextValue = {
    theme,
    mode,
    setMode,
    toggleMode: () => setMode(mode === 'light' ? 'dark' : 'light'),
  };

  return (
    <ThemeContext.Provider value={value}>
      <div style={style as React.CSSProperties} className="contents">
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider />');
  return ctx;
}
