/**
 * Phone numbers: the country list, E.164 normalisation, and display formatting.
 *
 * All three used to be private to one React component. The customer sign-in screen held a
 * two-entry COUNTRIES list, its own normalizePhone with a hardcoded `dial === '+66'` branch,
 * and the driver app — which authenticates by phone through the same synthetic-email scheme —
 * got none of it and shipped whatever the rider typed.
 *
 * THE ACCOUNT KEY DEPENDS ON THIS FILE. A customer's login is a synthetic email derived from
 * the E.164 digits (c<digits>@customer.favornoms.local, d<digits>@driver.favornoms.local), so
 * a number that normalises differently is a different account and locks the owner out of
 * their own. `toE164` is therefore byte-for-byte compatible with the old US and TH behaviour,
 * and phone.test.ts pins that with the old implementation transcribed as an oracle. Any change
 * here that moves a US or TH result is a breaking change to live logins, not a refactor.
 */

export interface CountryDial {
  /**
   * ISO 3166-1 alpha-2, and the stable key — NOT the dial code. +1 is both US and CA with
   * different placeholders, and +7 is both RU and KZ.
   */
  iso: string;
  /** Dialling code with its plus, e.g. '+66'. */
  dial: string;
  /** What the picker shows. */
  label: string;
  /** A number written the way someone from there would write it. */
  placeholder: string;
  /**
   * National trunk prefix to strip before the dial code is prepended, or null when a leading
   * digit is part of the number. Italy is the trap: +39 06 … is correct and stripping the
   * zero makes the number unreachable. Russia and Kazakhstan use 8, not 0.
   */
  trunk: string | null;
  /** Valid national-significant-number lengths. Guards both the trunk and country-code strips. */
  nsnLengths: number[];
  /**
   * How to group the national number for display, when the country writes it a particular
   * way and we are sure of it. Omitted means "group in threes from the right", which is
   * readable everywhere and wrong nowhere in particular. Only filled in for the countries
   * the product actually sells into — a guessed grouping is worse than an honest generic one.
   */
  displayGroups?: number[];
}

const C = (
  iso: string,
  dial: string,
  label: string,
  placeholder: string,
  trunk: string | null,
  nsnLengths: number[],
  displayGroups?: number[],
): CountryDial => ({
  iso,
  dial,
  label,
  placeholder,
  trunk,
  nsnLengths,
  ...(displayGroups ? { displayGroups } : {}),
});

/**
 * The countries the picker offers, alphabetically by label within the leading group.
 *
 * US and TH lead because they are the two the product already sells into and the two whose
 * normalisation must not move. Argentina is deliberately absent: its mobiles need a 9
 * INSERTED after the country code on top of a trunk strip, which no other entry needs, and a
 * wrong guess there produces a number that silently fails to receive anything.
 */
export const COUNTRY_DIALS: readonly CountryDial[] = [
  C('US', '+1', 'United States (+1)', '(555) 234-5678', null, [10]),
  C('TH', '+66', 'Thailand (+66)', '081 234 5678', '0', [9], [2, 3, 4]),
  C('CA', '+1', 'Canada (+1)', '(416) 234-5678', null, [10]),
  C('AE', '+971', 'United Arab Emirates (+971)', '050 123 4567', '0', [9]),
  C('AU', '+61', 'Australia (+61)', '0412 345 678', '0', [9]),
  C('AT', '+43', 'Austria (+43)', '0664 123456', '0', [10, 11, 12]),
  C('BD', '+880', 'Bangladesh (+880)', '01712 345678', '0', [10]),
  C('BE', '+32', 'Belgium (+32)', '0470 12 34 56', '0', [9]),
  C('BR', '+55', 'Brazil (+55)', '(11) 91234-5678', '0', [10, 11]),
  C('KH', '+855', 'Cambodia (+855)', '012 345 678', '0', [8, 9]),
  C('CL', '+56', 'Chile (+56)', '9 1234 5678', null, [9]),
  C('CN', '+86', 'China (+86)', '131 2345 6789', '0', [11]),
  C('DK', '+45', 'Denmark (+45)', '32 12 34 56', null, [8]),
  C('EG', '+20', 'Egypt (+20)', '0100 123 4567', '0', [10]),
  C('FR', '+33', 'France (+33)', '06 12 34 56 78', '0', [9]),
  C('DE', '+49', 'Germany (+49)', '01512 3456789', '0', [10, 11]),
  C('HK', '+852', 'Hong Kong (+852)', '5123 4567', null, [8]),
  C('IN', '+91', 'India (+91)', '081234 56789', '0', [10]),
  C('ID', '+62', 'Indonesia (+62)', '0812 345 678', '0', [9, 10, 11]),
  C('IE', '+353', 'Ireland (+353)', '085 012 3456', '0', [9]),
  // Trunk null, deliberately: an Italian landline really is +39 06 …
  C('IT', '+39', 'Italy (+39)', '312 345 6789', null, [9, 10, 11]),
  C('JP', '+81', 'Japan (+81)', '090-1234-5678', '0', [9, 10]),
  C('KZ', '+7', 'Kazakhstan (+7)', '8 701 234 5678', '8', [10]),
  C('KE', '+254', 'Kenya (+254)', '0712 345678', '0', [9]),
  C('LA', '+856', 'Laos (+856)', '020 12 345 678', '0', [9, 10]),
  C('MY', '+60', 'Malaysia (+60)', '012-345 6789', '0', [9, 10]),
  // Mexico abolished the extra mobile 1 in 2020.
  C('MX', '+52', 'Mexico (+52)', '55 1234 5678', null, [10]),
  C('MM', '+95', 'Myanmar (+95)', '09 123 456 789', '0', [9, 10]),
  C('NL', '+31', 'Netherlands (+31)', '06 12345678', '0', [9]),
  C('NZ', '+64', 'New Zealand (+64)', '021 123 4567', '0', [8, 9]),
  C('NG', '+234', 'Nigeria (+234)', '0802 123 4567', '0', [10]),
  C('NO', '+47', 'Norway (+47)', '406 12 345', null, [8]),
  C('PK', '+92', 'Pakistan (+92)', '0301 2345678', '0', [10]),
  C('PH', '+63', 'Philippines (+63)', '0917 123 4567', '0', [10]),
  C('PL', '+48', 'Poland (+48)', '512 345 678', '0', [9]),
  C('PT', '+351', 'Portugal (+351)', '912 345 678', null, [9]),
  C('RU', '+7', 'Russia (+7)', '8 916 123 4567', '8', [10]),
  C('SA', '+966', 'Saudi Arabia (+966)', '050 123 4567', '0', [9]),
  C('SG', '+65', 'Singapore (+65)', '8123 4567', null, [8]),
  C('ZA', '+27', 'South Africa (+27)', '071 234 5678', '0', [9]),
  C('KR', '+82', 'South Korea (+82)', '010-1234-5678', '0', [9, 10]),
  C('ES', '+34', 'Spain (+34)', '612 345 678', null, [9]),
  C('LK', '+94', 'Sri Lanka (+94)', '071 234 5678', '0', [9]),
  C('SE', '+46', 'Sweden (+46)', '070-123 45 67', '0', [7, 8, 9]),
  C('CH', '+41', 'Switzerland (+41)', '078 123 45 67', '0', [9]),
  C('TW', '+886', 'Taiwan (+886)', '0912 345 678', '0', [9]),
  C('TR', '+90', 'Turkey (+90)', '0501 234 56 78', '0', [10]),
  C('GB', '+44', 'United Kingdom (+44)', '07400 123456', '0', [10]),
  C('VN', '+84', 'Vietnam (+84)', '091 234 56 78', '0', [9]),
];

export const DEFAULT_COUNTRY_ISO = 'US';

const US = COUNTRY_DIALS[0] as CountryDial;

/** The country for an ISO code, falling back to the default rather than throwing. */
export function countryForIso(iso: string | null | undefined): CountryDial {
  if (!iso) return US;
  const upper = iso.trim().toUpperCase();
  return COUNTRY_DIALS.find((c) => c.iso === upper) ?? US;
}

/**
 * Turn what somebody typed into E.164.
 *
 * The order is load-bearing and matches the behaviour this replaced:
 *   1. A pasted "+…" is taken verbatim — the selector is irrelevant to a number that already
 *      carries its own country code.
 *   2. An international prefix (00 / 011) means the same thing as a plus.
 *   3. The country code, if the typist included it without a plus (1 555…, 66 81…).
 *   4. The national trunk prefix (0, or 8 in Russia), only when what remains is a plausible
 *      national number — otherwise "0812345678" in a country with no trunk loses a real digit.
 */
export function toE164(raw: string, country: CountryDial): string {
  const trimmed = (raw ?? '').trim();
  if (trimmed.startsWith('+')) return `+${trimmed.replace(/\D/g, '')}`;

  let digits = trimmed.replace(/\D/g, '');
  if (!digits) return country.dial;

  // 00 (most of the world) and 011 (NANP) both introduce an international number.
  for (const idd of ['011', '00']) {
    if (digits.startsWith(idd) && digits.length > idd.length + 6) {
      return `+${digits.slice(idd.length)}`;
    }
  }

  const cc = country.dial.slice(1);
  const fits = (n: number) => country.nsnLengths.includes(n);

  // Typed WITH the country code but no plus. Guarded on the remainder being a plausible
  // national length, because a Russian mobile written 8 916 123 4567 starts with an 8 and a
  // naive prefix test would eat the trunk digit as though it were a country code.
  if (digits.startsWith(cc) && fits(digits.length - cc.length)) {
    digits = digits.slice(cc.length);
  }

  if (country.trunk && digits.startsWith(country.trunk) && fits(digits.length - country.trunk.length)) {
    digits = digits.slice(country.trunk.length);
  }

  return `${country.dial}${digits}`;
}

/**
 * Render a stored E.164 number for a person to read.
 *
 * NANP numbers get the shape the owner asked for, "+1 (555) 234-5678"; everything else is
 * grouped from the right in a way that stays readable without pretending to know each
 * country's national format. Anything that cannot be parsed comes back untouched — a
 * half-written number in a list is better than a confidently wrong one.
 *
 * NEVER put the result in a tel: href. The parentheses and spaces are for eyes only; dialling
 * wants the raw E.164.
 */
export function formatPhone(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;

  // The till stamps +10000000000 on a walk-in, because place-order wants a phone and there
  // is nobody to take one from. Unformatted it read as obvious junk; formatted it would read
  // as "+1 (000) 000-0000", which a cashier could mistake for a number worth calling. A
  // number with no information in it is not a number.
  if (/^0+$/.test(digits.slice(1))) return '';

  // NANP, with or without the leading 1.
  if ((digits.length === 11 && digits.startsWith('1')) || digits.length === 10) {
    const ten = digits.length === 11 ? digits.slice(1) : digits;
    return `+1 (${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }

  if (!raw.startsWith('+')) return raw;

  // Longest dial code first, so +1 never claims a +1876 number.
  const dial = [...new Set(COUNTRY_DIALS.map((c) => c.dial.slice(1)))]
    .sort((a, b) => b.length - a.length)
    .find((d) => digits.startsWith(d) && digits.length > d.length + 4);
  if (!dial) return raw;

  const nsn = digits.slice(dial.length);

  // A country we know the shape of, and the number is the right length for it.
  const known = COUNTRY_DIALS.find(
    (c) =>
      c.dial.slice(1) === dial &&
      c.displayGroups &&
      c.displayGroups.reduce((a, b) => a + b, 0) === nsn.length,
  );
  if (known?.displayGroups) {
    let at = 0;
    const parts = known.displayGroups.map((n) => nsn.slice(at, (at += n)));
    return `+${dial} ${parts.join(' ')}`;
  }

  // Groups of three from the LEFT leave a lone trailing digit on 10-digit numbers; from the
  // right it lands on the first group instead, which is how national formats read.
  const groups: string[] = [];
  for (let end = nsn.length; end > 0; end -= 3) {
    groups.unshift(nsn.slice(Math.max(0, end - 3), end));
  }
  return `+${dial} ${groups.join(' ')}`;
}
