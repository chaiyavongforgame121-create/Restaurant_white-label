'use client';

// The other half of recovery, and the last step of a staff invitation.
//
// Reached with a session already in hand — /auth/callback exchanged the emailed code before
// redirecting here — so this page only has to call updateUser. It is also linked from the
// signed-in settings area, which is why it tolerates an ordinary session as well as a
// recovery one.

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { authErrorKey } from '../../_lib/auth-error';

/** GoTrue's default minimum is 6; 8 is the shortest length worth asking a restaurant owner
 *  to remember for an account that can refund orders and read payouts. Enforced here and by
 *  the project's own password policy — this check is UX, not the security boundary. */
const MIN_LENGTH = 8;

export function UpdatePasswordView({ welcome }: { welcome: boolean }) {
  const router = useRouter();
  const t = useTranslations('auth');
  const [ready, setReady] = React.useState<'checking' | 'ok' | 'no_session'>('checking');
  const [password, setPassword] = React.useState('');
  const [confirm, setConfirm] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [done, setDone] = React.useState(false);

  React.useEffect(() => {
    void (async () => {
      const supabase = getBrowserClient();
      const { data } = await supabase.auth.getUser();
      setReady(data.user ? 'ok' : 'no_session');
    })();
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (password.length < MIN_LENGTH) {
      setError(t('updatePassword.errors.tooShort', { min: MIN_LENGTH }));
      return;
    }
    if (password !== confirm) {
      setError(t('updatePassword.errors.mismatch'));
      return;
    }
    setSubmitting(true);
    const supabase = getBrowserClient();
    // password_set tells the invitation page this account can already sign in, so it does not
    // ask for a password a second time.
    const { error: updateError } = await supabase.auth.updateUser({ password, data: { password_set: true } });
    setSubmitting(false);
    if (updateError) {
      console.error('[update-password] updateUser failed:', updateError.message);
      setError(t(authErrorKey(updateError)));
      return;
    }
    setDone(true);
    // Straight into the app: the recovery session is a real session, so there is nothing
    // left to sign in with.
    router.replace('/');
    router.refresh();
  };

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4 py-10">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <KeyRound className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-center font-display text-3xl font-bold">
          {welcome ? t('updatePassword.welcomeTitle') : t('updatePassword.resetTitle')}
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          {welcome ? t('updatePassword.welcomeSubtitle') : t('updatePassword.resetSubtitle')}
        </p>

        <Card className="mt-6 p-5">
          {ready === 'checking' && (
            <p className="text-center text-sm text-muted-foreground">{t('updatePassword.checking')}</p>
          )}

          {ready === 'no_session' && (
            <div className="text-center">
              <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
              <p className="mt-3 font-display text-lg font-semibold">{t('updatePassword.expiredTitle')}</p>
              <p className="mt-1 text-sm text-muted-foreground">{t('updatePassword.expiredBody')}</p>
              <Link href="/forgot-password">
                <Button variant="gradient" size="lg" className="mt-5" fullWidth>
                  {t('updatePassword.sendNewLink')}
                </Button>
              </Link>
            </div>
          )}

          {ready === 'ok' && (
            <form className="space-y-4" onSubmit={submit}>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t('fields.newPassword')}</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  minLength={MIN_LENGTH}
                  autoComplete="new-password"
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                />
                <span className="mt-1 block text-xs text-muted-foreground">
                  {t('fields.minLength', { min: MIN_LENGTH })}
                </span>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">{t('fields.confirmPassword')}</span>
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  required
                  autoComplete="new-password"
                  className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
                />
              </label>
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button
                type="submit"
                variant="gradient"
                size="xl"
                fullWidth
                loading={submitting || done}
              >
                {t('updatePassword.submit')}
              </Button>
            </form>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
