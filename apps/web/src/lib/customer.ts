'use client';

import { getBrowserClient } from '@favornoms/database/client';

// The ONE way the storefront answers "which customer row am I?".
//
// Settings, the address book, reserve and checkout must all resolve identity
// the same way — when they don't (e.g. querying `customers` by user_id and
// taking the newest row) they can land on DIFFERENT rows, and a name the diner
// saves in settings never reaches checkout. `get_or_create_my_customer` is
// authoritative: it either returns a uuid or raises.

const CUSTOMER_ERRORS: Array<[string, string]> = [
  ['auth_required', 'Your session expired. Please sign in again.'],
  ['branch_not_found', 'We couldn’t find this restaurant. Please reload the page.'],
  ['customer_identity_unavailable', 'We couldn’t set up your profile. Please try again.'],
];

/** Turn a Postgres error message into something a diner can act on. */
export function describeCustomerError(message: string): string {
  for (const [code, text] of CUSTOMER_ERRORS) {
    if (message.includes(code)) return text;
  }
  return message;
}

/** Resolve (creating if needed) the signed-in diner's customer row. Throws on failure. */
export async function resolveMyCustomerId(branchId: string): Promise<string> {
  const supabase = getBrowserClient();
  const { data, error } = await supabase.rpc('get_or_create_my_customer', {
    p_branch_id: branchId,
  });
  if (error) throw new Error(describeCustomerError(error.message));
  const customerId = (data as string | null) ?? null;
  if (!customerId) throw new Error(describeCustomerError('customer_identity_unavailable'));
  return customerId;
}
