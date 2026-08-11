'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Building2, Mail, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { currentOrigin, safeNext } from '@favornoms/shared';

export function LoginView({ next }: { next: string }) {
  const router = useRouter();
  // Shared open-redirect guard — see @favornoms/shared. `next` feeds router.replace() on
  // SIGNED_IN and the magic-link emailRedirectTo below, so a hostile value would hand a
  // freshly-minted *staff* session to an attacker's page. Falls back to the dashboard root.
  // During prerender currentOrigin() is '' and this resolves to '/', but target is never
  // rendered, so hydration can't mismatch.
  const target = safeNext(next, currentOrigin()) ?? '/';
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: {
        emailRedirectTo:
          typeof window !== 'undefined'
            ? `${window.location.origin}${target}`
            : undefined,
        shouldCreateUser: false,
      },
    });
    setSubmitting(false);
    if (error) {
      setError(error.message);
      return;
    }
    setSent(true);
  };

  React.useEffect(() => {
    const supabase = getBrowserClient();
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN') {
        router.replace(target);
        router.refresh();
      }
    });
    return () => sub.subscription.unsubscribe();
  }, [router, target]);

  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-warm text-white shadow-warm">
          <Building2 className="h-8 w-8" />
        </div>
        <h1 className="mt-5 text-center font-display text-3xl font-bold">Favornoms Merchant</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          Sign in to manage your restaurant
        </p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">Check your inbox</p>
              <p className="mt-1 text-sm text-muted-foreground">
                We sent a sign-in link to <strong>{email}</strong>.
              </p>
            </div>
          ) : (
            <form className="space-y-4" onSubmit={submit}>
              <label className="block">
                <span className="mb-2 block text-sm font-medium">Email</span>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    placeholder="owner@example.com"
                    className="focus-ring w-full rounded-xl border border-border bg-background py-3 pl-11 pr-4 text-base"
                  />
                </div>
              </label>
              {error && <p className="text-sm text-danger">{error}</p>}
              <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
                Send sign-in link
              </Button>
            </form>
          )}
        </Card>

        {/* shouldCreateUser stays false above, so an unknown email fails here
            rather than silently creating an empty account. /signup is the
            deliberate way in. */}
        <p className="mt-4 text-center text-sm text-muted-foreground">
          New to Favornoms?{' '}
          <Link href="/signup" className="font-semibold text-primary hover:underline">
            Start a free 14-day trial
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
