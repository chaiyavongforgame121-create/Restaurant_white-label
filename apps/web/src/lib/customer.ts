'use client';

import { getBrowserClient } from '@favornoms/database/client';

// The ONE way the storefront answers "which customer row am I?".
//
// A diner has one customers row PER BRANCH: each branch keeps its own record of them (name,
// phone, email, consent, address book, points). The login is the only thing shared. So the
// answer always depends on the branch being browsed, and settings, the address book, reserve
// and checkout must all resolve it the same way — querying `customers` by user_id alone lands
// on whichever branch's row comes first, and a name saved in this branch's settings never
// reaches this branch's checkout. `get_or_create_my_customer(branch)` is authoritative: it
// either returns this branch's row (creating it on first use) or raises.

/**
 * The failures a diner can act on, keyed by the code Postgres raises, to the `account.errors.*`
 * message that explains them. This module cannot translate (no hooks here), so it names the
 * message and the screen that shows the error translates it.
 */
const CUSTOMER_ERRORS: Array<[string, CustomerErrorKey]> = [
  ['auth_required', 'sessionExpired'],
  ['branch_not_found', 'branchNotFound'],
  ['customer_identity_unavailable', 'profileUnavailable'],
];

export type CustomerErrorKey = 'sessionExpired' | 'branchNotFound' | 'profileUnavailable';

/**
 * The `account.errors.*` key for a failure thrown by resolveMyCustomerId (or a raw Postgres message),
 * or null when it is not one we can put into words — show `account.errors.generic` then.
 */
export function customerErrorKey(error: unknown): CustomerErrorKey | null {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  for (const [code, key] of CUSTOMER_ERRORS) {
    if (message.includes(code)) return key;
  }
  return null;
}

/**
 * Resolve (creating if needed) the signed-in diner's customer row AT THIS BRANCH. Throws on
 * failure, with the server's message (which carries the code customerErrorKey reads) so callers
 * can translate it.
 */
export async function resolveMyCustomerId(branchId: string): Promise<string> {
  const supabase = getBrowserClient();
  const { data, error } = await supabase.rpc('get_or_create_my_customer', {
    p_branch_id: branchId,
  });
  if (error) throw new Error(error.message);
  const customerId = (data as string | null) ?? null;
  if (!customerId) throw new Error('customer_identity_unavailable');
  return customerId;
}
