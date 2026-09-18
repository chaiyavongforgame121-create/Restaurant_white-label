/**
 * The customer's phone number, as a cashier types it at the till.
 *
 * Two jobs need it. A delivery cannot go out without one -- the rider has to be able to call --
 * and place-order refused every delivery rung up here because the till sent a placeholder. And an
 * optional number on any sale lets place-order find THIS branch's customer by phone, so a walk-in
 * earns their points instead of the cashier's own account earning them.
 *
 * Both only work with the number in the E.164 form customer-auth stores (+15551234567), so a
 * cashier who types "555 123 4567" or "081 234 5678" has to be read against the country the branch
 * is in. There is no country column; the branch's timezone says it well enough for a default, and
 * a number typed with its own +code is taken as it stands.
 */

import { countryForIso, toE164, type CountryDial } from '@favornoms/shared';

/** What the till stamps on an order when nobody gave a number. place-order needs one. */
export const WALK_IN_PHONE = '+10000000000';

const ZONE_COUNTRY: Record<string, string> = {
  'Asia/Bangkok': 'TH',
  'Asia/Ho_Chi_Minh': 'VN',
  'Asia/Saigon': 'VN',
  'Asia/Phnom_Penh': 'KH',
  'Asia/Vientiane': 'LA',
  'Asia/Yangon': 'MM',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Singapore': 'SG',
  'Europe/Madrid': 'ES',
  'Europe/London': 'GB',
  'America/Mexico_City': 'MX',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
};

/** The country a branch's customers most likely dial from, going by the branch's timezone. */
export function countryForTimezone(timezone: string | null | undefined): CountryDial {
  const iso = timezone ? ZONE_COUNTRY[timezone] : undefined;
  // Every other America/* and Pacific/Honolulu zone the back office offers is a US one, and US
  // is also the default the rest of the product falls back to.
  return countryForIso(iso ?? 'US');
}

export type PhoneState = 'empty' | 'valid' | 'invalid';

export interface CounterPhone {
  state: PhoneState;
  /** E.164 when valid, otherwise null. */
  e164: string | null;
}

/** E.164 allows at most 15 digits; nothing real is shorter than 7 after the country code. */
const plausibleInternational = (digits: string) => digits.length >= 8 && digits.length <= 15;

export function readCounterPhone(raw: string, country: CountryDial): CounterPhone {
  const trimmed = (raw ?? '').trim();
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return { state: 'empty', e164: null };

  const e164 = toE164(trimmed, country);
  const all = e164.replace(/\D/g, '');
  // The walk-in placeholder is not a customer, whoever types it; and no country code starts
  // with 0, which place-order's E.164 check refuses too.
  if (/^1?0+$/.test(all) || all.startsWith('0')) return { state: 'invalid', e164: null };

  if (!e164.startsWith(country.dial) || trimmed.startsWith('+')) {
    // Typed with its own country code (a plus, 00 or 011): the length is all there is to check.
    return plausibleInternational(all)
      ? { state: 'valid', e164: `+${all}` }
      : { state: 'invalid', e164: null };
  }
  const national = e164.slice(country.dial.length).replace(/\D/g, '');
  return country.nsnLengths.includes(national.length)
    ? { state: 'valid', e164 }
    : { state: 'invalid', e164: null };
}
