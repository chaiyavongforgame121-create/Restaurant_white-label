import type { FavornomsClient } from '../client-type';
import type { Database } from '../types';
import { getSupabaseEnv } from '../env';

// Card payments through Stripe Connect (docs/PAYMENTS-STRIPE-CONNECT-2026-09-24.md): which
// Stripe account each branch is paid into, and the calls the admin makes to connect one.
//
// branch_payment_accounts is written only by the stripe-connect-onboard and stripe-connect-webhook
// edge functions. RLS lets staff holding branch.settings (owner, admin, and platform admins) read
// their branches' rows; everyone else reads nothing, which these helpers return as "none".

export type BranchPaymentAccount = Database['public']['Tables']['branch_payment_accounts']['Row'];

/** A connected account row with the branch it pays, for the "use the same account" choice and
 *  the platform console's per-restaurant view. */
export interface RestaurantPaymentAccount extends BranchPaymentAccount {
  branch_name: string;
}

/** This branch's connected account, or null when it has none or the caller may not see it. */
export async function getBranchPaymentAccount(
  supabase: FavornomsClient,
  branchId: string,
): Promise<BranchPaymentAccount | null> {
  const { data, error } = await supabase
    .from('branch_payment_accounts')
    .select('*')
    .eq('branch_id', branchId)
    .maybeSingle();
  if (error) {
    console.error('getBranchPaymentAccount failed', error);
    return null;
  }
  return (data as BranchPaymentAccount | null) ?? null;
}

/**
 * Every connected account row of a restaurant the caller may read, oldest branch first. The owner
 * sees all of them (branch.settings everywhere), a branch-scoped admin only their own, and a
 * platform admin every restaurant's, which is the platform console's read.
 */
export async function listRestaurantPaymentAccounts(
  supabase: FavornomsClient,
  restaurantId: string,
): Promise<RestaurantPaymentAccount[]> {
  const { data, error } = await supabase
    .from('branch_payment_accounts')
    .select('*, branches!inner(name, restaurant_id, created_at)')
    .eq('branches.restaurant_id', restaurantId);
  if (error) {
    console.error('listRestaurantPaymentAccounts failed', error);
    return [];
  }
  type Joined = BranchPaymentAccount & { branches: { name: string; created_at: string } | null };
  return ((data ?? []) as unknown as Joined[])
    .sort((a, b) => (a.branches?.created_at ?? '').localeCompare(b.branches?.created_at ?? ''))
    .map(({ branches, ...row }) => ({ ...row, branch_name: branches?.name ?? '' }));
}

// --- stripe-connect-onboard ------------------------------------------------------------------

export type StripeConnectAction = 'start' | 'refresh' | 'share' | 'dashboard' | 'disconnect';

/** The account state the edge function answers with, the same columns as the row. */
export type StripeConnectState = Pick<
  BranchPaymentAccount,
  'charges_enabled' | 'payouts_enabled' | 'details_submitted' | 'requirements_due' | 'disabled_reason'
>;

export type StripeConnectResponse =
  /** STRIPE_SECRET_KEY is not set on the platform yet: nothing to connect to. */
  | { dormant: true }
  | {
      dormant: false;
      /** start: the Stripe onboarding page. dashboard: where the account is managed. */
      url?: string;
      connected?: boolean;
      state?: StripeConnectState | null;
    };

/** A refusal from the function, carrying its error code (forbidden, already_connected, ...). */
export class StripeConnectError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(`stripe-connect-onboard_failed:${code}`);
    this.name = 'StripeConnectError';
  }
}

/**
 * Calls the stripe-connect-onboard edge function as the signed-in user. The function checks the
 * capability itself (billing.manage to connect, share or disconnect; branch.settings to refresh
 * or open the dashboard), so a hidden button is a convenience, not the gate.
 */
export async function callStripeConnect(
  supabase: FavornomsClient,
  body: { branch_id: string; action: StripeConnectAction; source_branch_id?: string },
): Promise<StripeConnectResponse> {
  const { data: session } = await supabase.auth.getSession();
  const accessToken = session?.session?.access_token;
  if (!accessToken) throw new StripeConnectError('not_signed_in', 401);

  const { url, publishableKey } = getSupabaseEnv();
  let res: Response;
  try {
    res = await fetch(`${url}/functions/v1/stripe-connect-onboard`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new StripeConnectError('network', 0);
  }

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch {
    /* non-JSON body: handled by the status below */
  }
  const code = typeof parsed?.error === 'string' ? parsed.error : null;
  // 503 is kept for "Stripe is not configured" alone; the function answers 502 when Stripe
  // itself refused or could not be reached.
  if (code === 'stripe_not_configured') return { dormant: true };
  if (!res.ok) throw new StripeConnectError(code ?? `http_${res.status}`, res.status);

  return {
    dormant: false,
    url: typeof parsed?.url === 'string' ? parsed.url : undefined,
    connected: typeof parsed?.connected === 'boolean' ? parsed.connected : undefined,
    state: (parsed?.state as StripeConnectState | null | undefined) ?? undefined,
  };
}
