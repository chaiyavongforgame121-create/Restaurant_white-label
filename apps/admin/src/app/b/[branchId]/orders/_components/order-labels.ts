// Display words for the values an order stores. The stored values (status, channel,
// payments.method) stay exactly as the database has them — filters, comparisons and URLs use
// those — and only what reaches the screen is looked up here.
import { useLocale, useTranslations } from 'next-intl';
import { DEFAULT_UI_LOCALE, intlLocaleFor, isUiLocale } from '@favornoms/shared';

export const ORDER_STATUSES = [
  'pending',
  'confirmed',
  'preparing',
  'ready',
  'out_for_delivery',
  'completed',
  'cancelled',
  'refunded',
] as const;

export const ORDER_CHANNELS = ['dine_in', 'pickup', 'delivery', 'qr_ordering'] as const;

const PAYMENT_METHODS = ['cash', 'card', 'transfer'] as const;

const includes = (list: readonly string[], value: string) => list.includes(value);

/** A value this screen has no word for yet still reads as something, never as a key path. */
const humanize = (value: string) => value.replace('_', ' ');

export function useOrderLabels() {
  const t = useTranslations('orders');
  return {
    status: (s: string) => (includes(ORDER_STATUSES, s) ? t(`status.${s}`) : humanize(s)),
    channel: (c: string) => (includes(ORDER_CHANNELS, c) ? t(`channel.${c}`) : humanize(c)),
    paymentMethod: (m: string) =>
      includes(PAYMENT_METHODS, m) ? t(`paymentMethod.${m}`) : humanize(m),
  };
}

/** The Intl tag for dates in the reader's language (Thai stays on the Gregorian calendar). */
export function useIntlLocale(): string {
  const locale = useLocale();
  return intlLocaleFor(isUiLocale(locale) ? locale : DEFAULT_UI_LOCALE);
}
