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
import { KeyRound, ShieldAlert } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';

/** GoTrue's default minimum is 6; 8 is the shortest length worth asking a restaurant owner
 *  to remember for an account that can refund orders and read payouts. Enforced here and by
 *  the project's own password policy — this check is UX, not the security boundary. */
const MIN_LENGTH = 8;

export function UpdatePasswordView({ welcome }: { welcome: boolean }) {
  const router = useRouter();
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
      setError(`Use at least ${MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error: updateError } = await supabase.auth.updateUser({ password });
    setSubmitting(false);
    if (updateError) {
      setError(updateError.message);
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
          {welcome ? 'Choose your password' : 'Set a new password'}
        </h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          {welcome
            ? 'One last step and your account is ready.'
            : 'You will use this to sign in from now on.'}
        </p>

        <Card className="mt-6 p-5">
          {ready === 'checking' && (
            <p className="text-center text-sm text-muted-foreground">Checking your link…</p>
          )}

          {ready === 'no_session' && (
            <div className="text-center">
              <ShieldAlert className="mx-auto h-10 w-10 text-warning" />
              <p className="mt-3 font-display text-lg font-semibold">This link has expired</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Reset links work once and only in the browser that requested them. Ask for a
                fresh one and open it here.
              </p>
              <Link href="/forgot-password">
                <Button variant="gradient" size="lg" className="mt-5" fullWidth>
                  Send a new link
                </Button>
              </Link>
            </div>
          )}

          {ready === 'ok' && (
            <form className="space-y-4" onSubmit={submit}>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">New password</span>
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
                  At least {MIN_LENGTH} characters.
                </span>
              </label>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Confirm password</span>
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
                Save password and continue
              </Button>
            </form>
          )}
        </Card>
      </motion.div>
    </div>
  );
}
