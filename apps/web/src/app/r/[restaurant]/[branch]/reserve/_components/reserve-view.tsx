'use client';

import * as React from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Calendar, CheckCircle2, ChevronLeft, Clock, UserRound, Users } from 'lucide-react';
import { Button, Card, IconButton } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { createReservation } from '@favornoms/database/queries';
import { useAuth } from '@/components/auth/use-auth';
import { describeCustomerError, resolveMyCustomerId } from '@/lib/customer';
import { SignInGate } from '../../account/_components/account-ui';

interface Props {
  base: string;
  branchId: string;
  branchName: string;
}

const TIME_SLOTS = [
  '11:00', '11:30', '12:00', '12:30', '13:00', '13:30',
  '17:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00', '20:30', '21:00',
];

const PARTY_SIZES = [1, 2, 3, 4, 5, 6, 7, 8];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function ReserveView({ base, branchId, branchName }: Props) {
  const router = useRouter();
  const { user, loading: authLoading } = useAuth();
  const [date, setDate] = React.useState(todayISO());
  const [time, setTime] = React.useState<string | null>(null);
  const [partySize, setPartySize] = React.useState(2);
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState<null | { id: string; reserved_for: string }>(null);
  const [error, setError] = React.useState<string | null>(null);
  // Profile prefill. Prefilled, never locked: the account name is often not the
  // name the table should be under (booking for a partner, a nickname the host
  // will actually call out), and a field the diner cannot correct is the exact
  // complaint this page had.
  const [profileLoading, setProfileLoading] = React.useState(true);
  const [profileError, setProfileError] = React.useState<string | null>(null);
  const [prefilled, setPrefilled] = React.useState(false);

  React.useEffect(() => {
    if (!user) {
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    setProfileError(null);
    void (async () => {
      try {
        const cid = await resolveMyCustomerId(branchId);
        if (cancelled) return;
        const supabase = getBrowserClient();
        const { data, error: dbErr } = await supabase
          .from('customers')
          .select('full_name, phone')
          .eq('id', cid)
          .maybeSingle();
        if (cancelled) return;
        if (dbErr) throw new Error(dbErr.message);
        // Fall back to the auth identity when the profile row is still bare —
        // a phone-OTP sign-in always has a verified number on the user.
        const metaName = (user.user_metadata?.full_name as string | undefined) ?? '';
        const authPhone = user.phone ? (user.phone.startsWith('+') ? user.phone : `+${user.phone}`) : '';
        const profileName = (data?.full_name ?? metaName).trim();
        const profilePhone = (data?.phone ?? authPhone).trim();
        if (profileName) setName(profileName);
        if (profilePhone) setPhone(profilePhone);
        if (profileName || profilePhone) setPrefilled(true);
      } catch (err) {
        // Never lock the diner out of booking over a prefill failure — they can
        // still type their details in.
        if (!cancelled) setProfileError((err as Error).message);
      } finally {
        // `finally` is the whole point: without it any throw above left the page
        // spinning forever.
        if (!cancelled) setProfileLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Keyed on user.id, not `user`: onAuthStateChange hands back a NEW object on every
    // TOKEN_REFRESHED, which re-ran this effect mid-session, flipped the form back to
    // "Loading…" and overwrote whatever the diner had typed with the profile values.
    // That is the "I can't change the name" complaint reappearing by another route.
  }, [user?.id, branchId]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!time) {
      setError('Please pick a time slot');
      return;
    }
    if (!name.trim() || !phone.trim()) {
      setError('Please add your name and phone number');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      // Treat input as browser local time. For server consistency, send ISO with offset.
      const local = new Date(`${date}T${time}`);
      const supabase = getBrowserClient();
      const result = await createReservation(supabase, {
        branch_id: branchId,
        customer_name: name.trim(),
        customer_phone: phone.trim(),
        party_size: partySize,
        reserved_for: local.toISOString(),
        notes: notes || undefined,
      });
      setSuccess({ id: result.id, reserved_for: result.reserved_for });
    } catch (err) {
      // Was dumping the raw Postgres text at the diner — the RLS failure this page
      // used to hit rendered as 'reservation_failed:new row violates row-level
      // security policy for table "reservations"'.
      const raw = (err as Error).message.replace(/^reservation_failed:/, '');
      setError(describeCustomerError(raw));
    } finally {
      setSubmitting(false);
    }
  };

  if (success) {
    const when = new Date(success.reserved_for).toLocaleString(undefined, {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
    return (
      <div className="container max-w-md pt-12 text-center">
        <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}>
          <CheckCircle2 className="mx-auto h-16 w-16 text-success" />
          <h1 className="mt-3 font-display text-3xl font-bold">You&apos;re booked!</h1>
          <p className="mt-1 text-muted-foreground">
            {branchName} · {when} · table for {partySize}
          </p>
          <Card className="mt-6 p-4 text-left text-sm">
            <p>Your request was sent to the restaurant. They may call {phone} if your time isn&apos;t available.</p>
          </Card>
          <Button variant="gradient" size="lg" className="mt-6" fullWidth onClick={() => router.push(base)}>
            Back to menu
          </Button>
        </motion.div>
      </div>
    );
  }

  // Booking a table is an account action: the restaurant has to be able to
  // recognise and call back whoever is holding it.
  if (authLoading || (user && profileLoading)) {
    return (
      <div className="container max-w-2xl pt-4">
        <ReserveHeader onBack={() => router.back()} />
        <p className="text-sm text-muted-foreground">Loading…</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="container max-w-2xl pt-4">
        <ReserveHeader onBack={() => router.back()} />
        <SignInGate base={base} message="Sign in to reserve a table — we'll use your account name and phone for the booking." />
      </div>
    );
  }

  return (
    <div className="container max-w-2xl pt-4">
      <ReserveHeader onBack={() => router.back()} />

      <form className="space-y-4" onSubmit={submit}>
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Calendar className="h-5 w-5 text-primary" /> Date
          </h2>
          <input
            type="date"
            value={date}
            min={todayISO()}
            onChange={(e) => setDate(e.target.value)}
            className="focus-ring mt-2 w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
          />
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Clock className="h-5 w-5 text-primary" /> Time
          </h2>
          <div className="mt-3 grid grid-cols-3 gap-2 sm:grid-cols-5">
            {TIME_SLOTS.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTime(t)}
                className={`focus-ring rounded-xl border px-2 py-2.5 text-sm font-semibold transition-colors ${
                  time === t
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <Users className="h-5 w-5 text-primary" /> Party size
          </h2>
          <div className="mt-3 grid grid-cols-4 gap-2 sm:grid-cols-8">
            {PARTY_SIZES.map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setPartySize(n)}
                className={`focus-ring rounded-xl border py-2.5 text-sm font-bold transition-colors ${
                  partySize === n
                    ? 'border-primary bg-primary text-primary-foreground'
                    : 'border-border bg-card hover:border-primary/40'
                }`}
              >
                {n}
              </button>
            ))}
          </div>
        </Card>

        <Card className="space-y-3 p-5">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold">
            <UserRound className="h-5 w-5 text-primary" /> Your details
          </h2>
          {profileError && (
            <p className="text-xs text-warning">
              We couldn&apos;t load your profile ({profileError}) — please enter your details below.
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Name</span>
            <input
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoComplete="name"
              className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
            />
          </label>
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Phone</span>
            <input
              required
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              autoComplete="tel"
              placeholder="(555) 123-4567"
              className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
            />
          </label>
          {prefilled && (
            <p className="text-xs text-muted-foreground">
              Prefilled from your account — edit either field to book under a different
              name or number.{' '}
              <Link href={`${base}/account/settings`} className="font-medium text-primary underline">
                Update your account
              </Link>
              .
            </p>
          )}
          <label className="block">
            <span className="mb-1 block text-sm font-medium">Notes (optional)</span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="High chair · birthday · allergy info"
              className="focus-ring w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-base"
            />
          </label>
        </Card>

        {error && (
          <Card className="border-danger/30 bg-danger/5 p-4 text-sm text-danger">{error}</Card>
        )}

        <Button type="submit" variant="gradient" size="xl" fullWidth loading={submitting}>
          Request reservation
        </Button>
      </form>
    </div>
  );
}

function ReserveHeader({ onBack }: { onBack: () => void }) {
  return (
    <header className="mb-5 flex items-center gap-3">
      <IconButton label="Back" onClick={onBack}>
        <ChevronLeft className="h-5 w-5" />
      </IconButton>
      <h1 className="font-display text-2xl font-bold">Reserve a table</h1>
    </header>
  );
}
