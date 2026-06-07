'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'framer-motion';
import { Calendar, CheckCircle2, ChevronLeft, Clock, UserRound, Users } from 'lucide-react';
import { Button, Card, IconButton } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';
import { createReservation } from '@favornoms/database/queries';

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
  const [date, setDate] = React.useState(todayISO());
  const [time, setTime] = React.useState<string | null>(null);
  const [partySize, setPartySize] = React.useState(2);
  const [name, setName] = React.useState('');
  const [phone, setPhone] = React.useState('');
  const [notes, setNotes] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [success, setSuccess] = React.useState<null | { id: string; reserved_for: string }>(null);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!time) {
      setError('Please pick a time slot');
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
        customer_name: name,
        customer_phone: phone,
        party_size: partySize,
        reserved_for: local.toISOString(),
        notes: notes || undefined,
      });
      setSuccess({ id: result.id, reserved_for: result.reserved_for });
    } catch (err) {
      setError((err as Error).message);
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
            <p>We&apos;ll send a confirmation to {phone}. The restaurant may reach out if your time isn&apos;t available.</p>
          </Card>
          <Button variant="gradient" size="lg" className="mt-6" fullWidth onClick={() => router.push(base)}>
            Back to menu
          </Button>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="container max-w-2xl pt-4">
      <header className="mb-5 flex items-center gap-3">
        <IconButton label="Back" onClick={() => router.back()}>
          <ChevronLeft className="h-5 w-5" />
        </IconButton>
        <h1 className="font-display text-2xl font-bold">Reserve a table</h1>
      </header>

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
              placeholder="08x-xxx-xxxx"
              className="focus-ring w-full rounded-xl border border-border bg-background px-4 py-3 text-base"
            />
          </label>
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
