'use client';

// Where a staff invitation lands, and where the invitee creates their account.
//
// Most invitations are now a link the restaurant shares itself (over LINE, say), because
// Supabase's mailer sends about two emails an hour and only to the project's team. Such a link
// carries nothing but the staff id, which grants nothing: the invitee signs in — with Google,
// whose addresses are already confirmed, or an existing account — and accept_staff_invite checks
// that the confirmed email is the invited one.
//
// Invitations sent by email use the Auth admin API, so that link comes back with the new
// session in the URL FRAGMENT (#access_token=…&refresh_token=…) — or, when the link is stale or
// already used, with #error_code=…. No server sees a fragment, so this page reads it itself.
//
// The fragment is untrusted input: anyone can build a link to this page with a token pair of
// their own. So a session is only taken from it when it is fresh and belongs to the address the
// invitation was sent to; it never replaces a different account's session without a click; and
// nothing is joined without a click either. Otherwise a crafted link could sign a merchant into an
// attacker's account on their own device.
//
// An emailed invitee has no password — the invitation created the account without one — so they
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
import { AuthDivider, ContinueWithGoogle, isInAppBrowser } from '@/components/auth/continue-with-google';
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
  | 'accept.errors.signedOut'
  | 'accept.errors.alreadyStaff'
  | 'accept.errors.emailMismatch'
  | 'accept.errors.emailMismatchUnknown'
  | 'accept.errors.joinFailed'
  | 'accept.errors.tooManyEmails'
  | 'accept.errors.emailFailed';

type LinkTokens = { accessToken: string; refreshToken: string; email: string };

/** The parts of the signed-in Supabase user this page reads. Structural rather than imported,
 *  like EmailOtpType in /auth/callback: apps/admin reaches supabase-js only transitively. */
type InviteeUser = {
  email?: string;
  invited_at?: string | null;
  user_metadata?: Record<string, unknown>;
  identities?: { provider: string }[] | null;
  app_metadata?: { providers?: string[] };
};

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

function describeAcceptError(message: string, invitedEmail: string | null): AcceptErrorKey {
  if (message.includes('invite_not_pending')) return 'accept.errors.alreadyUsed';
  if (message.includes('invite_not_found')) return 'accept.errors.notFound';
  if (message.includes('email_not_confirmed')) return 'accept.errors.confirmEmail';
  // The session ended between opening the page and pressing Join (expired, or signed out in
  // another tab); the address itself is fine, so talking about confirming it would mislead.
  if (message.includes('sign_in_required')) return 'accept.errors.signedOut';
  if (message.includes('already_staff_here')) return 'accept.errors.alreadyStaff';
  // The database compares addresses exactly, so a Gmail account spelled with or without dots
  // is "someone else" here; naming the invited address is the only useful hint.
  if (message.includes('invite_email_mismatch'))
    return invitedEmail ? 'accept.errors.emailMismatch' : 'accept.errors.emailMismatchUnknown';
  return 'accept.errors.joinFailed';
}

/** Signs in some other way than an email and password (Google today). */
function hasOtherSignIn(user: InviteeUser): boolean {
  if (user.identities?.some((identity) => identity.provider !== 'email')) return true;
  const providers = user.app_metadata?.providers;
  return Array.isArray(providers) && providers.some((provider) => provider !== 'email');
}

/** Created by an invitation and never given a password (the flag is written wherever one is set).
 *  Someone who already signs in with Google has a way back in, and making them invent a password
 *  first would only stand between them and the Join button. */
function needsPassword(user: InviteeUser): boolean {
  if (hasOtherSignIn(user)) return false;
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

/** This page's URL with openExternalBrowser=1, when it is open inside LINE's own browser (where
 *  Google refuses to sign anyone in) and has not been sent out once already. LINE hands a URL
 *  carrying that flag to the phone's real browser, and the flag stops a second attempt, so this can
 *  never loop. Only LINE: Facebook and Instagram ignore the flag, so for them it would be a
 *  pointless reload (the Google button still warns there). The fragment goes along: an emailed
 *  invitation's tokens are needed wherever the page ends up. */
function externalBrowserUrl(): string | null {
  if (!/\bLine\//i.test(window.navigator.userAgent)) return null;
  const url = new URL(window.location.href);
  if (url.searchParams.get('openExternalBrowser') === '1') return null;
  url.searchParams.set('openExternalBrowser', '1');
  return url.toString();
}

/** How long a page that asked to leave an in-app browser waits before carrying on where it is. */
const EXTERNAL_BROWSER_GRACE_MS = 2500;

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
      const messageKey = describeAcceptError((err as Error).message, invite.invitedEmail);
      if (messageKey === 'accept.errors.joinFailed') console.error('[invite] accept failed:', (err as Error).message);
      setState({ kind: 'error', invite, messageKey });
    }
  }, [staffId]);

  /** With the invitee's own session in place: ask for a password if they have none, else confirm. */
  const nextStepFor = React.useCallback(
    (invite: StaffInvite, user: InviteeUser) => {
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
    const open = async () => {
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
    };

    // A shared link is usually tapped inside LINE, whose own browser cannot finish a Google
    // sign-in. Nothing is cleaned up first, so the page that loads outside starts afresh.
    const external = externalBrowserUrl();
    if (!external) {
      void open();
      return;
    }

    // The session check below is asynchronous, so this effect can be cleaned up (unmounted, or
    // re-run by Strict Mode) before it answers. `cancelled` keeps a stale answer from redirecting or
    // setting state, and `started` keeps any one run from opening the invitation twice.
    let cancelled = false;
    let started = false;
    let timer: number | undefined;
    const openOnce = () => {
      if (cancelled || started) return;
      started = true;
      void open();
    };

    // Someone already signed in inside LINE would arrive signed OUT in the real browser, which
    // shares no cookies with it, and be asked to sign in again for nothing: they need no Google
    // sign-in, so they stay. getSession only reads this browser's stored session; the fragment is
    // left in place (the client is PKCE, so it never takes tokens from it) for open() to read.
    getBrowserClient()
      .auth.getSession()
      .then(
        ({ data }) => {
          if (cancelled) return;
          if (data.session) {
            openOnce();
            return;
          }
          window.location.replace(external);
          // LINE opens the real browser but can leave this page showing behind it, and a navigation
          // that did happen unloads the page before the timer fires. Either way nobody is left on
          // "Opening your invitation…", and the sign-in screen there warns about in-app browsers.
          timer = window.setTimeout(openOnce, EXTERNAL_BROWSER_GRACE_MS);
        },
        // Unable to tell: carry on here rather than risk moving a signed-in person out.
        () => openOnce(),
      );
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
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
          <Card className="p-6">
            {state.expired && (
              <div className="mb-5 flex gap-3 rounded-xl bg-warning/10 px-4 py-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                <div>
                  <p className="text-sm font-semibold">{t('accept.needsLink.expiredTitle')}</p>
                  <p className="mt-0.5 text-sm text-muted-foreground">{t('accept.needsLink.expiredBody')}</p>
                </div>
              </div>
            )}
            <h1 className="text-center font-display text-2xl font-bold">
              {t('accept.needsLink.title', { workplace, role: roleLabel(state.invite.role) })}
            </h1>
            <p className="mt-1 text-center text-sm text-muted-foreground">
              {t.rich('accept.needsLink.googleHint', { email: state.invite.invitedEmail, strong })}
            </p>
            {/* Google first: it needs no email from us, and its addresses arrive already confirmed,
                which is what accept_staff_invite requires. login_hint only pre-selects the
                account; the invited address is still checked when joining. */}
            <ContinueWithGoogle
              className="mt-5"
              next={`/invite/accept?staff_id=${staffId ?? ''}`}
              loginHint={state.invite.invitedEmail}
            />
            <AuthDivider />
            <Link
              href={loginHref}
              className="focus-ring flex min-h-12 w-full items-center justify-center rounded-xl border border-border px-4 py-2.5 text-center text-sm font-medium transition-colors hover:bg-muted"
            >
              {t('accept.needsLink.signIn')}
            </Link>
            <p className="mt-4 text-center text-xs text-muted-foreground">
              {t.rich('accept.needsLink.noGoogle', {
                email: state.invite.invitedEmail,
                strong,
                // Google, not our /signup: that one needs a confirmation email, and Supabase's mailer
                // reaches almost nobody. Google accepts an existing non-Gmail address and confirms it
                // itself, which is what joining checks. A new tab keeps this invitation open.
                googleSignup: (c) => (
                  <a
                    href="https://accounts.google.com/signup"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-primary underline underline-offset-2"
                  >
                    {c}
                  </a>
                ),
              })}
            </p>
            {/* Only an invitation sent by email created an account to set a password on. For a
                shared link there is no account yet, and GoTrue quietly sends nothing while reporting
                success — so the notice below says what happens IF they were emailed, never "sent",
                and points back to Google, which stays on the screen above it. */}
            <div className="mt-5 border-t border-border pt-4 text-center">
              <p className="text-xs text-muted-foreground">{t('accept.needsLink.emailInvited')}</p>
              {linkSent ? (
                <p role="status" className="mt-2 rounded-xl bg-muted px-4 py-3 text-sm text-foreground">
                  {t('accept.needsLink.sent', { email: state.invite.invitedEmail })}
                </p>
              ) : (
                <button
                  type="button"
                  disabled={sendingLink}
                  aria-busy={sendingLink}
                  onClick={() => void emailPasswordLink(state.invite)}
                  className="focus-ring mt-1 inline-flex items-center gap-2 rounded-lg px-2 py-1 text-sm font-medium text-primary underline underline-offset-2 disabled:opacity-60"
                >
                  {sendingLink && (
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
                    />
                  )}
                  {t('accept.needsLink.sendLink')}
                </button>
              )}
            </div>
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
                // The sign-in choices come next, and Google always asks which account to use.
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
                  : t.rich(state.messageKey, { email: state.invite?.invitedEmail ?? '', strong })}
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
