'use client';

// Where a staff invitation lands, and where the invitee creates their account.
//
// Invitations are sent with the Auth admin API, so the email link comes back with the new
// session in the URL FRAGMENT (#access_token=…&refresh_token=…) — or, when the link is stale or
// already used, with #error_code=…. No server sees a fragment, so this page reads it itself.
//
// The fragment is untrusted input: anyone can build a link to this page with a token pair of
// their own. So a session is only taken from it when it is fresh and belongs to the address the
// invitation was sent to; it never replaces a different account's session without a click; and
// nothing is joined without a click either. Otherwise a crafted link could sign a merchant into an
// attacker's account on their own device.
//
// A new invitee has no password — the invitation created the account without one — so they
// choose it here, next to the address it belongs to, before joining.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { CheckCircle2, ChefHat, KeyRound, Mail, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { acceptStaffInvite, getStaffInvite, type StaffInvite } from '@favornoms/database/queries';

/** The same minimum the password reset page asks for; the project's own policy still has the final say. */
const MIN_PASSWORD = 8;

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  manager: 'Manager',
  cashier: 'Cashier',
  server: 'Server',
  kitchen: 'Kitchen',
  staff: 'Staff',
  driver: 'Driver',
};

type LinkTokens = { accessToken: string; refreshToken: string; email: string };

type State =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'used'; invite: StaffInvite }
  | { kind: 'needs_link'; invite: StaffInvite; expired: boolean }
  | { kind: 'wrong_account'; invite: StaffInvite; signedInAs: string }
  | { kind: 'switch_account'; invite: StaffInvite; signedInAs: string; tokens: LinkTokens }
  | { kind: 'confirm_join'; invite: StaffInvite; email: string }
  | { kind: 'create_account'; invite: StaffInvite; email: string }
  | { kind: 'joining'; invite: StaffInvite }
  | { kind: 'done'; invite: StaffInvite }
  | { kind: 'error'; invite: StaffInvite | null; message: string };

function describeAcceptError(message: string): string {
  if (message.includes('invite_not_pending')) return 'This invitation has already been used.';
  if (message.includes('invite_not_found')) return 'This invitation no longer exists. Ask the restaurant to invite you again.';
  if (message.includes('email_not_confirmed') || message.includes('sign_in_required'))
    return 'Open the invitation link from your email again to confirm your address.';
  if (message.includes('already_staff_here'))
    return 'You already work at this restaurant with this account, at the same branch. Sign in to continue.';
  return 'Something went wrong joining the restaurant. Please try again.';
}

/** Created by an invitation and never given a password (the flag is written wherever one is set). */
function needsPassword(user: { invited_at?: string | null; user_metadata?: Record<string, unknown> }): boolean {
  return !!user.invited_at && user.user_metadata?.password_set !== true;
}

/** The payload of a JWT, without verifying it — only to decide whether it is worth handing to
 *  GoTrue, which does verify it. */
function decodeJwt(token: string): { exp?: number; email?: string } | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '='));
    return JSON.parse(json) as { exp?: number; email?: string };
  } catch {
    return null;
  }
}

function readFragment(): { tokens: LinkTokens | null; error: string | null; present: boolean } {
  const raw = window.location.hash.replace(/^#/, '');
  if (!raw) return { tokens: null, error: null, present: false };
  const params = new URLSearchParams(raw);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  const error = params.get('error_code') ?? params.get('error');
  if (!accessToken || !refreshToken) return { tokens: null, error, present: true };
  const claims = decodeJwt(accessToken);
  // An expired access token would make setSession quietly fall back to the refresh token, which
  // for a crafted link can stay valid for months. A real invitation is opened within the hour.
  const fresh = !!claims?.exp && claims.exp * 1000 > Date.now();
  if (!fresh || !claims?.email) return { tokens: null, error: error ?? 'otp_expired', present: true };
  return { tokens: { accessToken, refreshToken, email: claims.email.toLowerCase() }, error, present: true };
}

export function AcceptInviteView({ staffId }: { staffId?: string }) {
  const router = useRouter();
  const [state, setState] = React.useState<State>({ kind: 'loading' });
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [formError, setFormError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [sendingLink, setSendingLink] = React.useState(false);
  const [linkSent, setLinkSent] = React.useState(false);

  const join = React.useCallback(async (invite: StaffInvite) => {
    setState({ kind: 'joining', invite });
    try {
      await acceptStaffInvite(getBrowserClient(), staffId!);
      setState({ kind: 'done', invite });
    } catch (err) {
      setState({ kind: 'error', invite, message: describeAcceptError((err as Error).message) });
    }
  }, [staffId]);

  /** With the invitee's own session in place: ask for a password if they have none, else confirm. */
  const nextStepFor = React.useCallback(
    (invite: StaffInvite, user: { email?: string; invited_at?: string | null; user_metadata?: Record<string, unknown> }) => {
      const email = user.email ?? invite.invitedEmail ?? '';
      if (needsPassword(user)) setState({ kind: 'create_account', invite, email });
      else setState({ kind: 'confirm_join', invite, email });
    },
    [],
  );

  const adoptLinkSession = React.useCallback(
    async (invite: StaffInvite, tokens: LinkTokens) => {
      const supabase = getBrowserClient();
      const { error } = await supabase.auth.setSession({
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
      });
      if (error) {
        setState({ kind: 'needs_link', invite, expired: true });
        return;
      }
      const { data } = await supabase.auth.getUser();
      if (!data.user || (data.user.email ?? '').toLowerCase() !== tokens.email) {
        setState({ kind: 'needs_link', invite, expired: true });
        return;
      }
      nextStepFor(invite, data.user);
    },
    [nextStepFor],
  );

  React.useEffect(() => {
    if (!staffId) {
      setState({ kind: 'not_found' });
      return;
    }
    void (async () => {
      const supabase = getBrowserClient();
      const fragment = readFragment();
      if (fragment.present) {
        // Out of the address bar at once, keeping Next's history state so Back still works, and
        // out of the router's own copy of the URL too.
        const clean = window.location.pathname + window.location.search;
        window.history.replaceState(window.history.state, '', clean);
        router.replace(clean, { scroll: false });
      }

      const invite = await getStaffInvite(supabase, staffId);
      if (!invite) {
        setState({ kind: 'not_found' });
        return;
      }
      const { data: userData } = await supabase.auth.getUser();
      const user = userData.user;

      if (invite.status === 'active') {
        // Only the account already signed in here can be the one that joined; a link's tokens
        // are never adopted for an invitation that is already used.
        if (user) {
          try {
            await acceptStaffInvite(supabase, staffId);
            if (needsPassword(user)) {
              setState({ kind: 'create_account', invite, email: user.email ?? '' });
            } else {
              setState({ kind: 'done', invite });
            }
            return;
          } catch {
            /* not this account's invitation */
          }
        }
        setState({ kind: 'used', invite });
        return;
      }
      if (invite.status !== 'pending' || !invite.invitedEmail) {
        setState({ kind: 'used', invite });
        return;
      }

      const invited = invite.invitedEmail.toLowerCase();
      const tokens = fragment.tokens && fragment.tokens.email === invited ? fragment.tokens : null;
      const signedInAs = (user?.email ?? '').toLowerCase();

      if (user && signedInAs === invited) {
        nextStepFor(invite, user);
        return;
      }
      if (tokens) {
        // A different account is signed in on this device: never swap it silently.
        if (user) setState({ kind: 'switch_account', invite, signedInAs: user.email ?? 'another account', tokens });
        else await adoptLinkSession(invite, tokens);
        return;
      }
      if (user) {
        setState({ kind: 'wrong_account', invite, signedInAs: user.email ?? 'another account' });
        return;
      }
      setState({ kind: 'needs_link', invite, expired: !!fragment.error || fragment.present });
    })();
  }, [staffId, router, nextStepFor, adoptLinkSession]);

  // Straight to the right screen once joined: the landing route picks the dashboard, the kitchen
  // display or the counter from the role.
  React.useEffect(() => {
    if (state.kind !== 'done') return;
    const timer = setTimeout(() => {
      router.replace('/');
      router.refresh();
    }, 1500);
    return () => clearTimeout(timer);
  }, [state.kind, router]);

  const createAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (state.kind !== 'create_account') return;
    setFormError(null);
    if (password.length < MIN_PASSWORD) {
      setFormError(`Use at least ${MIN_PASSWORD} characters.`);
      return;
    }
    if (password !== confirm) {
      setFormError('The two passwords do not match.');
      return;
    }
    setSaving(true);
    const supabase = getBrowserClient();
    // Password first: if joining then fails, the person still has an account they can sign in to
    // and retry from, rather than a membership they can only reach through another emailed link.
    const { error } = await supabase.auth.updateUser({ password, data: { password_set: true } });
    if (error) {
      // GoTrue only says same_password after checking the typed password against the stored one:
      // this person already had this exact password, which is as good as setting it.
      if (error.code === 'same_password') {
        await supabase.auth.updateUser({ data: { password_set: true } });
      } else {
        setSaving(false);
        setFormError(error.message);
        return;
      }
    }
    setSaving(false);
    await join(state.invite);
  };

  const emailPasswordLink = async (invite: StaffInvite) => {
    if (!invite.invitedEmail || !staffId) return;
    setSendingLink(true);
    const next = `/invite/accept?staff_id=${staffId}`;
    const { error } = await getBrowserClient().auth.resetPasswordForEmail(invite.invitedEmail, {
      redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
    });
    setSendingLink(false);
    if (error) {
      setState({
        kind: 'error',
        invite,
        message:
          error.status === 429
            ? 'Too many emails were sent in the last hour. Please try again later.'
            : 'We could not send the email. Please try again, or ask the restaurant to invite you again.',
      });
      return;
    }
    setLinkSent(true);
  };

  const invite = 'invite' in state ? state.invite : null;
  const workplace = invite
    ? `${invite.restaurantName}${invite.branchName ? ` · ${invite.branchName}` : ''}`
    : null;
  const loginHref = `/login?next=${encodeURIComponent(`/invite/accept?staff_id=${staffId ?? ''}`)}`;

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-10">
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <ChefHat className="h-8 w-8" />
        </div>

        {(state.kind === 'loading' || state.kind === 'joining') && (
          <Card className="p-6 text-center">
            <p className="font-display text-xl font-semibold">
              {state.kind === 'joining' ? 'Joining the team…' : 'Opening your invitation…'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">One moment.</p>
          </Card>
        )}

        {state.kind === 'create_account' && (
          <Card className="p-6">
            <p className="text-center text-sm text-muted-foreground">
              You&apos;re invited to join <strong className="text-foreground">{workplace}</strong> as{' '}
              <strong className="text-foreground">{ROLE_LABEL[state.invite.role] ?? state.invite.role}</strong>.
            </p>
            <h1 className="mt-4 text-center font-display text-2xl font-bold">Create your account</h1>
            <form onSubmit={createAccount} className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">Email</span>
                <span className="relative block">
                  <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  {/* The address the invitation was sent to. It is the account's sign-in name, so
                      it is shown, not edited: a different address would be a different account. */}
                  <input
                    value={state.email}
                    readOnly
                    aria-readonly="true"
                    autoComplete="username"
                    className="input pl-9 opacity-80"
                  />
                </span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete="new-password"
                  minLength={MIN_PASSWORD}
                  required
                  autoFocus
                  className="input"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  At least {MIN_PASSWORD} characters. You&apos;ll use this to sign in on the restaurant&apos;s devices.
                </span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">Confirm password</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  autoComplete="new-password"
                  required
                  className="input"
                />
              </label>
              {formError && (
                <p role="alert" className="rounded-xl bg-destructive/10 px-4 py-3 text-sm text-destructive">
                  {formError}
                </p>
              )}
              <Button type="submit" variant="gradient" size="lg" fullWidth loading={saving} leftIcon={<KeyRound className="h-4 w-4" />}>
                Create account &amp; join
              </Button>
            </form>
          </Card>
        )}

        {state.kind === 'confirm_join' && (
          <Card className="p-6 text-center">
            <p className="font-display text-xl font-semibold">Join {workplace}?</p>
            <p className="mt-1 text-sm text-muted-foreground">
              You&apos;ll join as <strong className="text-foreground">{ROLE_LABEL[state.invite.role] ?? state.invite.role}</strong>{' '}
              using <strong className="text-foreground">{state.email}</strong>.
            </p>
            <Button variant="gradient" size="lg" className="mt-5" fullWidth onClick={() => void join(state.invite)}>
              Join the team
            </Button>
          </Card>
        )}

        {state.kind === 'switch_account' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">Switch accounts?</p>
            <p className="mt-1 text-sm text-muted-foreground">
              This invitation is for <strong className="text-foreground">{state.invite.invitedEmail}</strong>, but this
              browser is signed in as <strong className="text-foreground">{state.signedInAs}</strong>. Continuing signs this
              browser out of {state.signedInAs} and in as {state.invite.invitedEmail}.
            </p>
            <Button
              variant="gradient"
              size="lg"
              className="mt-5"
              fullWidth
              onClick={async () => {
                const tokens = state.tokens;
                const target = state.invite;
                setState({ kind: 'loading' });
                await getBrowserClient().auth.signOut({ scope: 'local' });
                await adoptLinkSession(target, tokens);
              }}
            >
              Continue as {state.invite.invitedEmail}
            </Button>
          </Card>
        )}

        {state.kind === 'needs_link' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">
              {state.expired ? 'This invitation link has expired' : 'Open the link from your email'}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.expired
                ? 'Invitation links work only once. We can email '
                : 'Open the invitation link in the email sent to '}
              <strong className="text-foreground">{state.invite.invitedEmail}</strong>
              {state.expired
                ? ' a new link to set your password and join — open it in this browser.'
                : ', or get a new link below.'}
            </p>
            {linkSent ? (
              <p className="mt-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
                Sent. Check {state.invite.invitedEmail} and open the newest email in this browser.
              </p>
            ) : (
              <Button
                variant="gradient"
                size="lg"
                className="mt-5"
                fullWidth
                loading={sendingLink}
                onClick={() => void emailPasswordLink(state.invite)}
              >
                Email me a link to set my password
              </Button>
            )}
            <Link href={loginHref} className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-2">
              Already created your password? Sign in
            </Link>
          </Card>
        )}

        {state.kind === 'wrong_account' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">This invitation is for someone else</p>
            <p className="mt-1 text-sm text-muted-foreground">
              It was sent to <strong className="text-foreground">{state.invite.invitedEmail}</strong>, but this
              browser is signed in as <strong className="text-foreground">{state.signedInAs}</strong>. Sign out here,
              then open the invitation link from that email again.
            </p>
            <Button
              variant="gradient"
              size="lg"
              className="mt-5"
              fullWidth
              onClick={async () => {
                // This browser only: the person pressing it is, by construction, not that account's
                // holder, and a global sign-out would end their sessions on every other device.
                await getBrowserClient().auth.signOut({ scope: 'local' });
                setState({ kind: 'needs_link', invite: state.invite, expired: false });
              }}
            >
              Sign out on this browser
            </Button>
          </Card>
        )}

        {(state.kind === 'used' || state.kind === 'not_found' || state.kind === 'error') && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-danger" />
            <p className="mt-3 font-display text-xl font-semibold">Couldn&apos;t accept invite</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.kind === 'used'
                ? 'This invitation has already been used. If it was yours, sign in — or use “Forgot password?” if you never chose one.'
                : state.kind === 'not_found'
                  ? 'This invitation link is incomplete or no longer exists. Ask the restaurant to invite you again.'
                  : state.message}
            </p>
            <Link href={loginHref} className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-2">
              Go to sign in
            </Link>
          </Card>
        )}

        {state.kind === 'done' && (
          <Card className="p-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <p className="mt-3 font-display text-xl font-semibold">You&apos;re in!</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Welcome to {workplace}. Taking you to your screen…
            </p>
          </Card>
        )}
      </motion.div>
    </div>
  );
}
