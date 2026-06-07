import type { Locale, LocalizedText } from '../types';

export function cn(...inputs: Array<string | undefined | null | false>): string {
  return inputs.filter(Boolean).join(' ');
}

const currencyFormatters = new Map<string, Intl.NumberFormat>();
export function formatCurrency(amount: number, currency = 'USD', locale: Locale = 'en'): string {
  const key = `${locale}:${currency}`;
  let f = currencyFormatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat(localeToBcp47(locale), {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    });
    currencyFormatters.set(key, f);
  }
  return f.format(amount);
}

export function localeToBcp47(_locale: Locale): string {
  return 'en-US';
}

export function pickLocalized(
  base: string,
  translations: LocalizedText | undefined,
  locale: Locale,
): string {
  if (!translations) return base;
  return translations[locale] ?? base;
}

export function distanceKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

export function distanceMiles(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  return distanceKm(a, b) * 0.621371;
}

export function formatRelativeTime(date: string | Date, locale: Locale = 'en'): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  const diffMin = Math.round((d.getTime() - Date.now()) / 60000);
  const rtf = new Intl.RelativeTimeFormat(localeToBcp47(locale), { numeric: 'auto' });
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const diffHr = Math.round(diffMin / 60);
  if (Math.abs(diffHr) < 24) return rtf.format(diffHr, 'hour');
  return rtf.format(Math.round(diffHr / 24), 'day');
}

export function generateOrderNumber(branchPrefix = 'A'): string {
  const now = new Date();
  const yymm = `${String(now.getFullYear()).slice(2)}${String(now.getMonth() + 1).padStart(2, '0')}`;
  const seq = String(Math.floor(Math.random() * 999999)).padStart(6, '0');
  return `${branchPrefix}-${yymm}-${seq}`;
}

// Format US phone number as (xxx) xxx-xxxx; accepts already-formatted or E.164 input.
export function formatUSPhone(input: string): string {
  const digits = input.replace(/\D/g, '');
  const ten = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (ten.length !== 10) return input;
  return `(${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
}

// US sales tax computation. Pass the rate as a decimal (e.g. 0.0875 for 8.75%).
export function computeSalesTax(subtotal: number, taxRate: number): number {
  return Math.round(subtotal * taxRate * 100) / 100;
}
