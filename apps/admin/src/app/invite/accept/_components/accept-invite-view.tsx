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
import { useTranslations } from 'next-intl';
import { CheckCircle2, ChefHat, KeyRound, Mail, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { acceptStaffInvite, getStaffInvite, type StaffInvite } from '@favornoms/database/queries';
import { LocaleSwitcher } from '@/components/locale-switcher';
import { authErrorKey } from '../../../auth/_lib/auth-error';

/** The same minimum the password reset page asks for; the project's own policy still has the final say. */
const MIN_PASSWORD = 8;

/** Roles with a label under `invite.roles.*`; anything else is shown as stored. */
const ROLES = ['owner', 'admin', 'manager', 'cashier', 'server', 'kitchen', 'staff', 'driver'] as const;
type Role = (typeof ROLES)[number];
const isRole = (role: string): role is Role => (ROLES as readonly string[]).includes(role);

/** `invite.accept.errors.*` keys. */
type AcceptErrorKey =
  | 'accept.errors.alreadyUsed'
  | 'accept.errors.notFound'
  | 'accept.errors.confirmEmail'
  | 'accept.errors.alreadyStaff'
  | 'accept.errors.joinFailed'
  | 'accept.errors.tooManyEmails'
  | 'accept.errors.emailFailed';

type LinkTokens = { accessToken: string; refreshToken: string; email: string };

type State =
  | { kind: 'loading' }
  | { kind: 'not_found' }
  | { kind: 'used'; invite: StaffInvite }
  | { kind: 'needs_link'; invite: StaffInvite; expired: boolean }
  // signedInAs is '' when the signed-in account has no email; the screen then says "another account".
  | { kind: 'wrong_account'; invite: StaffInvite; signedInAs: string }
  | { kind: 'switch_account'; invite: StaffInvite; signedInAs: string; tokens: LinkTokens }
  | { kind: 'confirm_join'; invite: StaffInvite; email: string }
  | { kind: 'create_account'; invite: StaffInvite; email: string }
  | { kind: 'joining'; invite: StaffInvite }
  | { kind: 'done'; invite: StaffInvite }
  | { kind: 'error'; invite: StaffInvite | null; messageKey: AcceptErrorKey };

function describeAcceptError(message: string): AcceptErrorKey {
  if (message.includes('invite_not_pending')) return 'accept.errors.alreadyUsed';
  if (message.includes('invite_not_found')) return 'accept.errors.notFound';
  if (message.includes('email_not_confirmed') || message.includes('sign_in_required'))
    return 'accept.errors.confirmEmail';
  if (message.includes('already_staff_here')) return 'accept.errors.alreadyStaff';
  return 'accept.errors.joinFailed';
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
  const t = useTranslations('invite');
  const tAuth = useTranslations('auth');
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
      const messageKey = describeAcceptError((err as Error).message);
      if (messageKey === 'accept.errors.joinFailed') console.error('[invite] accept failed:', (err as Error).message);
      setState({ kind: 'error', invite, messageKey });
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
        if (user) setState({ kind: 'switch_account', invite, signedInAs: user.email ?? '', tokens });
        else await adoptLinkSession(invite, tokens);
        return;
      }
      if (user) {
        setState({ kind: 'wrong_account', invite, signedInAs: user.email ?? '' });
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
      setFormError(t('accept.errors.passwordTooShort', { min: MIN_PASSWORD }));
      return;
    }
    if (password !== confirm) {
      setFormError(t('accept.errors.passwordsDontMatch'));
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
        console.error('[invite] updateUser failed:', error.message);
        setFormError(tAuth(authErrorKey(error)));
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
        messageKey: error.status === 429 ? 'accept.errors.tooManyEmails' : 'accept.errors.emailFailed',
      });
      return;
    }
    setLinkSent(true);
  };

  const invite = 'invite' in state ? state.invite : null;
  // Restaurant and branch names are the merchant's own, shown as entered.
  const workplace = invite
    ? `${invite.restaurantName}${invite.branchName ? ` · ${invite.branchName}` : ''}`
    : null;
  const loginHref = `/login?next=${encodeURIComponent(`/invite/accept?staff_id=${staffId ?? ''}`)}`;
  const roleLabel = (role: string) => (isRole(role) ? t(`roles.${role}`) : role);
  const strong = (c: React.ReactNode) => <strong className="text-foreground">{c}</strong>;

  return (
    <div className="relative grid min-h-dynamic-screen place-items-center bg-background px-4 pb-10 pt-16">
      <div className="absolute right-4 top-4">
        <LocaleSwitcher />
      </div>
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="w-full max-w-md">
        <div className="mx-auto mb-6 grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <ChefHat className="h-8 w-8" />
        </div>

        {(state.kind === 'loading' || state.kind === 'joining') && (
          <Card className="p-6 text-center">
            <p className="font-display text-xl font-semibold">
              {state.kind === 'joining' ? t('accept.joining') : t('accept.opening')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">{t('accept.oneMoment')}</p>
          </Card>
        )}

        {state.kind === 'create_account' && (
          <Card className="p-6">
            <p className="text-center text-sm text-muted-foreground">
              {t.rich('accept.createAccount.invited', {
                workplace,
                role: roleLabel(state.invite.role),
                strong,
              })}
            </p>
            <h1 className="mt-4 text-center font-display text-2xl font-bold">{t('accept.createAccount.title')}</h1>
            <form onSubmit={createAccount} className="mt-5 space-y-4">
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">{t('accept.createAccount.email')}</span>
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
                <span className="mb-1.5 block text-sm font-medium">{t('accept.createAccount.password')}</span>
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
                  {t('accept.createAccount.passwordHint', { min: MIN_PASSWORD })}
                </span>
              </label>
              <label className="block">
                <span className="mb-1.5 block text-sm font-medium">{t('accept.createAccount.confirmPassword')}</span>
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
                {t('accept.createAccount.submit')}
              </Button>
            </form>
          </Card>
        )}

        {state.kind === 'confirm_join' && (
          <Card className="p-6 text-center">
            <p className="font-display text-xl font-semibold">{t('accept.confirmJoin.title', { workplace })}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich('accept.confirmJoin.body', {
                role: roleLabel(state.invite.role),
                email: state.email,
                strong,
              })}
            </p>
            <Button variant="gradient" size="lg" className="mt-5" fullWidth onClick={() => void join(state.invite)}>
              {t('accept.confirmJoin.submit')}
            </Button>
          </Card>
        )}

        {state.kind === 'switch_account' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">{t('accept.switchAccount.title')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich('accept.switchAccount.body', {
                invited: state.invite.invitedEmail,
                current: state.signedInAs || t('accept.anotherAccount'),
                strong,
              })}
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
              {t('accept.switchAccount.submit', { invited: state.invite.invitedEmail })}
            </Button>
          </Card>
        )}

        {state.kind === 'needs_link' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">
              {state.expired ? t('accept.needsLink.expiredTitle') : t('accept.needsLink.openTitle')}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich(state.expired ? 'accept.needsLink.expiredBody' : 'accept.needsLink.openBody', {
                email: state.invite.invitedEmail,
                strong,
              })}
            </p>
            {linkSent ? (
              <p className="mt-4 rounded-xl bg-success/10 px-4 py-3 text-sm text-success">
                {t('accept.needsLink.sent', { email: state.invite.invitedEmail })}
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
                {t('accept.needsLink.sendLink')}
              </Button>
            )}
            <Link href={loginHref} className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-2">
              {t('accept.needsLink.signIn')}
            </Link>
          </Card>
        )}

        {state.kind === 'wrong_account' && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
            <p className="mt-3 font-display text-xl font-semibold">{t('accept.wrongAccount.title')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t.rich('accept.wrongAccount.body', {
                invited: state.invite.invitedEmail,
                current: state.signedInAs || t('accept.anotherAccount'),
                strong,
              })}
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
              {t('accept.wrongAccount.signOut')}
            </Button>
          </Card>
        )}

        {(state.kind === 'used' || state.kind === 'not_found' || state.kind === 'error') && (
          <Card className="p-6 text-center">
            <ShieldAlert className="mx-auto h-10 w-10 text-danger" />
            <p className="mt-3 font-display text-xl font-semibold">{t('accept.failed.title')}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {state.kind === 'used'
                ? t('accept.failed.used')
                : state.kind === 'not_found'
                  ? t('accept.failed.notFound')
                  : t(state.messageKey)}
            </p>
            <Link href={loginHref} className="mt-4 inline-block text-sm font-medium text-primary underline underline-offset-2">
              {t('accept.failed.goToSignIn')}
            </Link>
          </Card>
        )}

        {state.kind === 'done' && (
          <Card className="p-6 text-center">
            <CheckCircle2 className="mx-auto h-10 w-10 text-success" />
            <p className="mt-3 font-display text-xl font-semibold">{t('accept.done.title')}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t('accept.done.body', { workplace })}</p>
          </Card>
        )}
      </motion.div>
    </div>
  );
}
