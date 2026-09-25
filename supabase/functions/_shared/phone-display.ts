// A stored phone number the way a person reads it, for edge functions that print one into a
// document (issue-tax-invoice's receipt today).
//
// A hand mirror of formatPhone() in packages/shared/src/utils/phone.ts, which a Deno function
// cannot import. The owner asked for every number the product shows to read "+1 (xxx) xxx-xxxx",
// and the receipt this runtime renders prints the seller's number where the apps' formatting
// cannot reach it. apps/admin/src/app/b/[branchId]/orders/_components/
// phone-display-edge.test.ts holds this file to the twin's answers and its dial table to
// COUNTRY_DIALS, so a change to either one fails there until the other follows.
//
// Imports nothing, so the admin app's test runner can load it without a Deno runtime.
//
// NOTE ON DEPLOYMENT — as with _shared/entitlements.ts, the Supabase CLI uploads the whole
// `supabase/functions` tree, so `../_shared/phone-display.ts` resolves. Through the Management
// API / MCP, pass this file as `_shared/phone-display.ts` next to `<fn>/index.ts`.
//
// NEVER put the result in a tel: or sms: href, or hand it to Twilio: the parentheses and spaces are
// for eyes only, and dialling wants the raw E.164.

/**
 * Every distinct dial code in COUNTRY_DIALS, without its plus. Only the codes matter here: which
 * country a code belongs to never changes how the number is grouped.
 */
export const DIAL_CODES: readonly string[] = [
  '1', '66', '971', '61', '43', '880', '32', '55', '855', '56', '86', '45', '20', '33', '49',
  '852', '91', '62', '353', '39', '81', '7', '254', '856', '60', '52', '95', '31', '64', '234',
  '47', '92', '63', '48', '351', '966', '65', '27', '82', '34', '94', '46', '41', '886', '90',
  '44', '84',
];

/**
 * COUNTRY_DIALS' `displayGroups`, by dial code: the countries whose own way of writing a number
 * the twin knows. Everywhere else is grouped in threes from the right.
 */
export const DISPLAY_GROUPS: Readonly<Record<string, readonly (readonly number[])[]>> = {
  '66': [[2, 3, 4]],
};

// Longest code first, so +1 never claims a +1876 number.
const DIALS_LONGEST_FIRST = [...DIAL_CODES].sort((a, b) => b.length - a.length);

/**
 * Render a stored E.164 number for a person to read: "+1 (555) 234-5678" for NANP, a readable
 * grouping for any other country ("+66 98 035 8264"), '' for the till's +10000000000 walk-in
 * stand-in, and anything unparseable back untouched. Must answer exactly as the twin does.
 */
export function formatPhone(input: string | null | undefined): string {
  const raw = (input ?? '').trim();
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return raw;

  // The walk-in placeholder carries no information; dressed up it would read as a number worth
  // calling.
  if (/^0+$/.test(digits.slice(1))) return '';

  // NANP: eleven digits led by the country code 1, or ten digits with no "+" that look like a
  // North American number. A number written with a "+" is NANP only when its country code is 1:
  // "+6581234567" (Singapore) is ten digits too, and used to come out as "+1 (658) 123-4567".
  // Without a "+", ten digits count only when an area code and an exchange could be real (they
  // never start with 0 or 1), so a Thai "0812345678" typed with no country code is left as typed
  // rather than turned into a wrong American number.
  const plus = raw.startsWith('+');
  const nanpTen = (ten: string) => /^[2-9]\d{2}[2-9]\d{6}$/.test(ten);
  if (
    (digits.length === 11 && digits.startsWith('1')) ||
    (!plus && digits.length === 10 && nanpTen(digits))
  ) {
    const ten = digits.length === 11 ? digits.slice(1) : digits;
    return `+1 (${ten.slice(0, 3)}) ${ten.slice(3, 6)}-${ten.slice(6)}`;
  }

  if (!raw.startsWith('+')) return raw;

  const dial = DIALS_LONGEST_FIRST.find((d) => digits.startsWith(d) && digits.length > d.length + 4);
  if (!dial) return raw;

  const nsn = digits.slice(dial.length);

  const groups = (DISPLAY_GROUPS[dial] ?? []).find(
    (shape) => shape.reduce((a, b) => a + b, 0) === nsn.length,
  );
  if (groups) {
    let at = 0;
    const parts = groups.map((n) => nsn.slice(at, (at += n)));
    return `+${dial} ${parts.join(' ')}`;
  }

  // From the right, so a 10-digit number's short group comes first, as national formats read.
  const threes: string[] = [];
  for (let end = nsn.length; end > 0; end -= 3) {
    threes.unshift(nsn.slice(Math.max(0, end - 3), end));
  }
  return `+${dial} ${threes.join(' ')}`;
}
