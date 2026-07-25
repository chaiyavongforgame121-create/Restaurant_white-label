import Link from 'next/link';
import { Lock } from 'lucide-react';
import { Button, Card } from '@favornoms/ui';

/**
 * Shown on back-office surfaces that create new business (the till) when the
 * subscription has lapsed. Deliberately NOT used on the kitchen display or the
 * recent-orders list: the billing gates are BEFORE INSERT, so orders already in
 * the pipe must still be cookable and printable. Locking those would strand a
 * restaurant mid-service over an invoice.
 */
export function SuspensionScreen({
  branchId,
  branchName,
  surface = 'This screen',
}: {
  branchId: string;
  branchName?: string;
  /** What is locked, e.g. "The counter". Used as the sentence subject. */
  surface?: string;
}) {
  return (
    <div className="grid min-h-dynamic-screen place-items-center bg-background px-4">
      <Card className="w-full max-w-md p-6 text-center">
        <Lock className="mx-auto h-12 w-12 text-warning" />
        <h1 className="mt-3 font-display text-2xl font-bold">Subscription inactive</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {surface} is locked for {branchName ?? 'this branch'} because the subscription has lapsed. No
          data has been deleted — choosing a package restores everything immediately.
        </p>
        <p className="mt-3 text-sm text-muted-foreground">
          Orders already placed can still be cooked and completed from the kitchen display.
        </p>
        <Link href={`/b/${branchId}/settings/plan`} className="mt-5 block">
          <Button variant="gradient" fullWidth>
            Go to billing
          </Button>
        </Link>
      </Card>
    </div>
  );
}
