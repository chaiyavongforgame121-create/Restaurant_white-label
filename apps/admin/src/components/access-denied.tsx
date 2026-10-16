'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { House, LogOut, ShieldX } from 'lucide-react';
import { Button, Card, buttonVariants } from '@favornoms/ui';
import { getBrowserClient } from '@favornoms/database/client';

export function AccessDenied({
  title,
  reason,
}: {
  /** Already translated by the caller; defaults to a translated "Access denied". */
  title?: string;
  /** Already translated by the caller. */
  reason: string;
}) {
  const t = useTranslations('shell.accessDenied');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const handleSignOut = async () => {
    const supabase = getBrowserClient();
    await supabase.auth.signOut();
    router.replace('/login');
    router.refresh();
  };
  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <ShieldX className="mx-auto h-12 w-12 text-danger" />
        <h1 className="mt-3 font-display text-2xl font-bold">{title ?? t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{reason}</p>
        <div className="mt-5 grid gap-2 sm:grid-cols-2">
          {/* Sign out used to be the only way off this card, so a cashier who typed a back-office
              URL had to sign out to get back to the till. '/' sends everyone to the screen their
              role starts on (the till, the kitchen board, the dashboard). A plain link, not a
              client navigation: '/' is a server redirect, and this card may sit under a layout
              that has nothing to do with where the redirect lands. */}
          <a
            href="/"
            className={buttonVariants({ variant: 'soft', fullWidth: true })}
          >
            <House className="h-4 w-4" />
            {t('backToMyScreen')}
          </a>
          <Button
            variant="ghost"
            leftIcon={<LogOut className="h-4 w-4" />}
            onClick={handleSignOut}
            fullWidth
          >
            {tCommon('signOut')}
          </Button>
        </div>
      </Card>
    </div>
  );
}
