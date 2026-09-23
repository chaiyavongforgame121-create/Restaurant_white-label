// The screen a delivery page shows for a branch that does not deliver.
//
// The three back-office delivery screens (Live deliveries, Drivers, Driver payouts) used
// to answer only "may this person manage deliveries", never "does this branch deliver at
// all", so a branch without the add-on kept a full delivery back office behind a guessable
// URL. They all render this instead.
//
// The words matter as much as the gate: delivery is bought per branch (docs/
// PACKAGING-2026-09-23.md §2), so a merchant who pays for delivery at their other branch
// must read "this branch does not deliver", not "your add-on is gone".

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Bike } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { LockedFeature } from '@/components/locked-feature';
import { oneTimePriceToShow } from '@/lib/delivery-gate-model';
import type { DeliveryGate } from '@/lib/delivery-gate';

export async function DeliveryLocked({
  branchId,
  branchName,
  gate,
}: {
  branchId: string;
  branchName: string;
  gate: DeliveryGate;
}) {
  const t = await getTranslations('misc');
  // A branch whose name could not be read (an RLS denial on the second query) must still
  // get a whole sentence — "  does not deliver" is the blank screen this replaces.
  const named = branchName.trim();
  // A branch that paid its unlock before and then switched delivery off pays nothing once to
  // switch it back on (docs/PACKAGING-2026-09-23.md §1). This screen used to quote the
  // catalog's $59 regardless — a charge the plan page and the server then do not make — so it
  // now says why only the monthly price is shown.
  const unlocked = gate.alreadyUnlocked === true;
  const description = unlocked
    ? named
      ? t('lockedFeature.deliveryUnlockedAtThisBranch', { branch: named })
      : t('lockedFeature.deliveryUnlockedHere')
    : named
      ? t('lockedFeature.deliveryNotAtThisBranch', { branch: named })
      : t('lockedFeature.deliveryNotHere');
  return (
    <LockedFeature
      branchId={branchId}
      feature="delivery"
      description={description}
      // Catalog prices, never constants: the owner reprices from the platform console and
      // a stale number here would be a promise the plan page then breaks. The one-time price
      // is this branch's (0 once unlocked), and a 0 is left out rather than printed as "$0".
      price={gate.monthlyPrice ?? undefined}
      oneTimePrice={oneTimePriceToShow(gate.oneTimePrice)}
      planHref={gate.planHref}
    />
  );
}

/**
 * The line a delivery screen carries while it is still open only because work is
 * outstanding: runs a rider has not finished, or money a rider is still owed.
 *
 * Locking those screens outright would be the stranding the packaging decision forbids
 * (§2), so they stay usable and say why they are still here.
 */
export async function DeliveryStoppedNotice({
  branchName,
  planHref,
  body,
}: {
  branchName: string;
  planHref: string;
  /** Already translated by the caller — each screen has outstanding work of its own kind. */
  body: string;
}) {
  const t = await getTranslations('misc');
  const named = branchName.trim();
  return (
    <div className="container max-w-4xl pt-6">
      <Card className="border-warning/40 bg-warning/5 p-4">
        <p className="flex items-start gap-2 text-sm">
          <Bike className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
          <span>
            <span className="font-semibold">
              {named
                ? t('lockedFeature.deliveryStoppedTitle', { branch: named })
                : t('lockedFeature.deliveryStoppedHere')}
            </span>{' '}
            <span className="text-muted-foreground">{body}</span>{' '}
            <Link
              href={planHref}
              className="focus-ring font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('lockedFeature.deliveryTurnBackOn')}
            </Link>
          </span>
        </p>
      </Card>
    </div>
  );
}
