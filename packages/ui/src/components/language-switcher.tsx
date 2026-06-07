'use client';

// LanguageSwitcher is intentionally a no-op in the US-only build.
// Kept exported so older imports do not break — renders nothing.
export type LocaleCode = 'en';

export function LanguageSwitcher() {
  return null;
}
