import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Card, RiderIcon } from '@favornoms/ui';

/**
 * Where a rider lands if they sign in to the merchant back office.
 *
 * `driver` is a staff role so a rider can appear in the restaurant's staff list, but it
 * carries no back-office capability — riders work in the Driver app, where access is
 * scoped by drivers.user_id and driver_approvals. Bouncing them to a login loop or an
 * "access denied" they cannot resolve reads as a broken account.
 */
export default async function NoAccessPage() {
  const t = await getTranslations('shell.noAccess');
  return (
    <div className="grid min-h-dynamic-screen place-items-center p-6">
      <Card className="max-w-md p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <RiderIcon className="h-7 w-7" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold">{t('title')}</h1>
        <p className="mt-2 text-muted-foreground">{t('body')}</p>
        <p className="mt-4 text-sm text-muted-foreground">{t('askOwner')}</p>
        <Link
          href="/login"
          className="focus-ring mt-6 inline-block rounded-xl px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10"
        >
          {t('signInAsSomeoneElse')}
        </Link>
      </Card>
    </div>
  );
}
