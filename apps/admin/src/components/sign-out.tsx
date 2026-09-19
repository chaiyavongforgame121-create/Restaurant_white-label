'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, LogOut } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import { cn } from '@favornoms/ui';

/** Sign this device out and land on the login page. `local` scope: a shared kitchen tablet or till
 *  signing out must not end the same person's session on their phone or another screen. */
function useSignOut() {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);
  const signOut = React.useCallback(async () => {
    setPending(true);
    try {
      await getBrowserClient().auth.signOut({ scope: 'local' });
    } finally {
      router.replace('/login');
      router.refresh();
    }
  }, [router]);
  return { signOut, pending };
}

/** Sidebar footer: who is signed in, and the way out. */
export function SignOutButton({ className }: { className?: string }) {
  const t = useTranslations('common');
  const { signOut, pending } = useSignOut();
  const [email, setEmail] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void getBrowserClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setEmail(data.user?.email ?? null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className={cn('space-y-1.5', className)}>
      {email && (
        <p className="truncate px-1 text-[11px] text-muted-foreground" title={email}>
          {t('signedInAs', { email })}
        </p>
      )}
      <button
        type="button"
        onClick={() => void signOut()}
        disabled={pending}
        className="focus-ring inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-border bg-card px-3 text-xs font-semibold text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
      >
        {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogOut className="h-4 w-4" />}
        {t('signOut')}
      </button>
    </div>
  );
}

/**
 * Header control for the full-screen boards (counter, kitchen), which have no sidebar. A stray tap
 * in the middle of service must not log the till out, so the first tap only arms it: the button
 * says "Tap again to sign out" for a few seconds, and only a second tap signs out.
 */
export function SignOutIconButton({
  className,
  style,
}: {
  className?: string;
  style?: React.CSSProperties;
}) {
  const t = useTranslations('common');
  const { signOut, pending } = useSignOut();
  const [armed, setArmed] = React.useState(false);

  React.useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      onClick={() => (armed ? void signOut() : setArmed(true))}
      disabled={pending}
      aria-label={armed ? t('signOutConfirm') : t('signOut')}
      title={armed ? t('signOutConfirm') : t('signOut')}
      className={cn(
        'inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg text-xs font-semibold disabled:opacity-60',
        armed ? 'px-2.5' : 'w-9',
        className,
      )}
      style={style}
    >
      {pending ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <LogOut className="h-[18px] w-[18px]" />}
      {armed && !pending && <span>{t('signOutConfirm')}</span>}
    </button>
  );
}
