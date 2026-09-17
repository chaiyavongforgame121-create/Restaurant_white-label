'use client';

// Where the platform console's messages become words. tenant-health.ts decides
// and names each message by key; this turns a key into the reader's language,
// formats its dates with the same UTC-pinned formatter, and maps the stable
// codes (plan, subscription status) that are shown to the operator to labels.

import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { DEFAULT_UI_LOCALE, isUiLocale, type UiLocale } from '@favornoms/shared';
import { fmtDate, type Msg } from './tenant-health';

export type PlatformT = ReturnType<typeof useTranslations<'platform'>>;

// Display only: the codes themselves are what gets sent and compared.
const PLAN_CODES = new Set(['base', 'trial', 'none']);
const STATUS_CODES = new Set(['active', 'trialing', 'past_due', 'cancelled', 'expired', 'none']);

export function usePlatformText() {
  const t = useTranslations('platform');
  const format = useFormatter();
  const raw = useLocale();
  const locale: UiLocale = isUiLocale(raw) ? raw : DEFAULT_UI_LOCALE;

  const date = (iso: string | null | undefined) => fmtDate(iso, locale);

  const text = (m: Msg): string => {
    if (!m.values) return t(m.key);
    const values: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(m.values)) {
      values[name] = typeof value === 'object' ? fmtDate(value.date, locale) : value;
    }
    return t(m.key, values);
  };

  const list = (items: string[]): string => format.list(items, { type: 'conjunction' });

  /** A plan code as the operator reads it; an unknown code is shown as it is. */
  const plan = (code: string): string => (PLAN_CODES.has(code) ? t(`plans.${code}`) : code);

  /** A subscription status code as the operator reads it; an unknown code is shown as it is. */
  const status = (code: string): string =>
    STATUS_CODES.has(code) ? t(`subscriptionStatus.${code}`) : code;

  return { t, locale, date, text, list, plan, status };
}

export type PlatformText = ReturnType<typeof usePlatformText>;

/**
 * The message key for a failed platform write. The raw database text is logged,
 * never shown: a known cause gets its own sentence, anything else the generic one.
 */
export function platformErrorKey(
  raw: string | null | undefined,
  code?: string | null,
  fallback: 'errors.generic' | 'errors.reactivateFailed' = 'errors.generic',
): string {
  if (raw || code) console.error('[platform] write failed', code ?? '', raw ?? '');
  const text = (raw ?? '').toLowerCase();
  if (
    code === '42501' ||
    text.includes('not_platform_admin') ||
    text.includes('permission denied') ||
    text.includes('not authorized')
  ) {
    return 'errors.notPlatformAdmin';
  }
  if (
    text.includes('failed to fetch') ||
    text.includes('networkerror') ||
    text.includes('network request failed') ||
    text.includes('load failed')
  ) {
    return 'errors.network';
  }
  return fallback;
}
