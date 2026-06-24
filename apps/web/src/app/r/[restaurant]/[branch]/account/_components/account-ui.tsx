'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ChevronLeft, LogIn } from 'lucide-react';
import { Button, IconButton } from '@favornoms/ui';

// Shared chrome for the account sub-pages (addresses / loyalty / settings):
// a back-to-account header and a sign-in gate for signed-out visitors.

export function AccountHeader({ base, title }: { base: string; title: string }) {
  const router = useRouter();
  return (
    <header className="mb-5 flex items-center gap-3">
      <IconButton label="Back" onClick={() => router.push(`${base}/account`)}>
        <ChevronLeft className="h-5 w-5" />
      </IconButton>
      <h1 className="font-display text-2xl font-bold">{title}</h1>
    </header>
  );
}

export function SignInGate({ base, message }: { base: string; message: string }) {
  return (
    <div className="rounded-2xl border border-border bg-card p-8 text-center">
      <p className="text-muted-foreground">{message}</p>
      <Link
        href={`${base}/sign-in?next=${encodeURIComponent(`${base}/account`)}`}
        className="mt-4 inline-block"
      >
        <Button variant="gradient" leftIcon={<LogIn className="h-4 w-4" />}>
          Sign in
        </Button>
      </Link>
    </div>
  );
}
