'use client';

import { Moon, Sun } from 'lucide-react';
import { useTheme } from '@favornoms/ui';

export function ThemeToggle() {
  const { mode, toggleMode } = useTheme();
  return (
    <button
      type="button"
      onClick={toggleMode}
      aria-label={mode === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
      className="focus-ring inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-semibold transition-colors hover:bg-muted"
    >
      {mode === 'dark' ? (
        <>
          <Sun className="h-4 w-4" /> Light mode
        </>
      ) : (
        <>
          <Moon className="h-4 w-4" /> Dark mode
        </>
      )}
    </button>
  );
}
