'use client';

import { getBrowserClient } from '@favornoms/database/client';

// The ONE way the storefront answers "which customer row am I?".
//
// Settings, the address book, reserve and checkout must all resolve identity
// the same way — when they don't (e.g. querying `customers` by user_id and
// taking the newest row) they can land on DIFFERENT rows, and a name the diner
// saves in settings never reaches checkout. `get_or_create_my_customer` is
// authoritative: it either returns a uuid or raises.

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
 * Resolve (creating if needed) the signed-in diner's customer row. Throws on failure, with the
 * server's message (which carries the code customerErrorKey reads) so callers can translate it.
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
