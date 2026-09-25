import { formatPhone } from '@favornoms/shared';

/**
 * The number the account card shows under the diner's name, formatted for reading
 * ("+1 (555) 234-5678", or "+66 98 035 8264" for a number that is not North American).
 *
 * The `customers` row wins and the auth column is the only fallback — account-view says why
 * user_metadata never is. Supabase Auth keeps its phone as bare digits ("66980358264", no
 * plus), and formatPhone only groups a number it can see is international, so the plus goes
 * back on first; without it a Thai number would come back as the unbroken run of digits this
 * exists to get rid of.
 *
 * Returns null when there is nothing worth showing — including the till's all-zero
 * placeholder, which formatPhone blanks — so the card falls through to the email instead of
 * painting an empty line.
 *
 * For eyes only. A tel: link wants the stored E.164, never this.
 */
export function accountPhoneLabel(
  profilePhone: string | null | undefined,
  authPhone: string | null | undefined,
): string | null {
  const stored = profilePhone?.trim();
  const fromProfile = stored ? formatPhone(stored) : '';
  if (fromProfile) return fromProfile;
  const auth = authPhone?.trim();
  if (!auth) return null;
  return formatPhone(auth.startsWith('+') ? auth : `+${auth}`) || null;
}
