'use client';

// Password recovery — and, just as importantly, password *creation*.
//
// Every merchant account that existed before the password login screen was magic-link only
// and therefore has no password at all. There was no route to give one to, so this page is
// the way an existing owner or staff member gets their first password: GoTrue's recovery
// mail does not care whether a password is being replaced or set for the first time.

import * as React from 'react';
import Link from 'next/link';
import { motion } from 'framer-motion';
import { KeyRound, Mail, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';

export function ForgotPasswordView() {
  const [email, setEmail] = React.useState('');
  const [sent, setSent] = React.useState(false);
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    const supabase = getBrowserClient();
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim(), {
      // Through /auth/callback, never straight to the form: recovery arrives as a PKCE
      // `?code=` that has to be exchanged server-side before the update-password page has a
      // session to update.
      redirectTo:
        typeof window !== 'undefined'
          ? `${window.location.origin}/auth/callback?next=${encodeURIComponent('/auth/update-password')}`
          : undefined,
    });
    setSubmitting(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    // Deliberately unconditional: reporting "no such account" here would turn this form into
    // an oracle for which of a restaurant's staff emails are registered.
    setSent(true);
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
        <h1 className="mt-5 text-center font-display text-3xl font-bold">Set a new password</h1>
        <p className="mt-1 text-center text-sm text-muted-foreground">
          We&apos;ll email you a link to choose one. Use this to set your first password too.
        </p>

        <Card className="mt-6 p-5">
          {sent ? (
            <div className="text-center">
              <ShieldCheck className="mx-auto h-10 w-10 text-success" />
              <p className="mt-3 font-display text-lg font-semibold">Check your inbox</p>
              <p className="mt-1 text-sm text-muted-foreground">
                If <strong>{email}</strong> has an account, a reset link is on its way. Open it
                in this browser — the link is tied to the one that asked for it.
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
                Email me a reset link
              </Button>
            </form>
          )}
        </Card>

        <p className="mt-4 text-center text-sm text-muted-foreground">
          <Link href="/login" className="font-semibold text-primary hover:underline">
            Back to sign in
          </Link>
        </p>
      </motion.div>
    </div>
  );
}
