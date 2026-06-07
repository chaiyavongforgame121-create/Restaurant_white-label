import type { FavornomsClient } from '../client-type';

/**
 * Send a Phone OTP to the given E.164 number.
 * Caller must have configured an SMS provider in Supabase Auth → SMS Settings.
 * In dev, Supabase emits OTPs to the dashboard log; you can read them there.
 *
 * For new sign-ups, pass `meta` so handle_new_user trigger creates the right row.
 */
export async function sendPhoneOtp(
  supabase: FavornomsClient,
  phone: string,
  meta?: {
    signup_type?: 'customer' | 'driver';
    branch_id?: string;
    full_name?: string;
  },
) {
  return supabase.auth.signInWithOtp({
    phone,
    options: {
      shouldCreateUser: true,
      data: meta,
    },
  });
}

export async function verifyPhoneOtp(
  supabase: FavornomsClient,
  phone: string,
  token: string,
) {
  return supabase.auth.verifyOtp({ phone, token, type: 'sms' });
}

export async function getCurrentUser(supabase: FavornomsClient) {
  const { data, error } = await supabase.auth.getUser();
  if (error) return null;
  return data.user ?? null;
}

export async function signOut(supabase: FavornomsClient) {
  return supabase.auth.signOut();
}
