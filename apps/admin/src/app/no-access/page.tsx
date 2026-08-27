import Link from 'next/link';
import { Bike } from 'lucide-react';
import { Card } from '@favornoms/ui';

/**
 * Where a rider lands if they sign in to the merchant back office.
 *
 * `driver` is a staff role so a rider can appear in the restaurant's staff list, but it
 * carries no back-office capability — riders work in the Driver app, where access is
 * scoped by drivers.user_id and driver_approvals. Bouncing them to a login loop or an
 * "access denied" they cannot resolve reads as a broken account.
 */
export default function NoAccessPage() {
  return (
    <div className="grid min-h-dynamic-screen place-items-center p-6">
      <Card className="max-w-md p-8 text-center">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-primary/10 text-primary">
          <Bike className="h-7 w-7" />
        </span>
        <h1 className="mt-4 font-display text-2xl font-bold">You&apos;re a driver here</h1>
        <p className="mt-2 text-muted-foreground">
          Driver accounts don&apos;t use the restaurant back office. Open the Favornoms
          Driver app to see the jobs assigned to you, your delivery history and your
          earnings.
        </p>
        <p className="mt-4 text-sm text-muted-foreground">
          If you should also have back-office access, ask the restaurant owner to invite
          you again with a manager or admin role.
        </p>
        <Link
          href="/login"
          className="focus-ring mt-6 inline-block rounded-xl px-4 py-2 text-sm font-semibold text-primary hover:bg-primary/10"
        >
          Sign in as someone else
        </Link>
      </Card>
    </div>
  );
}
