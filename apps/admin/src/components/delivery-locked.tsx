// The screen a delivery page shows for a branch that does not deliver.
//
// The three back-office delivery screens (Live deliveries, Drivers, Driver payouts) used
// to answer only "may this person manage deliveries", never "does this branch deliver at
// all", so a branch that did not deliver kept a full delivery back office behind a guessable
// URL. They all render this instead.
//
// The words matter as much as the gate. Delivery is in the plan at every branch, behind a
// free switch in branch settings (docs/PACKAGING-2026-10-24.md §3), so there is nothing to
// buy: the screen says whether the switch is off (and where it is) or delivery is off for the
// whole restaurant (and to contact FavorNoms). Never a price, never the plan page.

import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { Bike } from 'lucide-react';
import { Card } from '@favornoms/ui';
import { LockedFeature } from '@/components/locked-feature';
import type { DeliveryGate } from '@/lib/delivery-gate';

export async function DeliveryLocked({
  branchName,
  gate,
  canSwitch,
}: {
  branchName: string;
  gate: DeliveryGate;
  /** branch.settings here: may open the switch (set_branch_delivery asks the same). */
  canSwitch: boolean;
}) {
  const t = await getTranslations('misc');
  // A branch whose name could not be read (an RLS denial on the second query) must still
  // get a whole sentence — "  does not deliver" is the blank screen this replaces.
  const named = branchName.trim();
  if (gate.reason === 'switchedOff') {
    const what = named
      ? t('lockedFeature.deliverySwitchedOffAtBranch', { branch: named })
      : t('lockedFeature.deliverySwitchedOffHere');
    // Someone who cannot open branch settings (a manager with delivery.manage) is told who
    // can, instead of being sent to a page that would only show them opening hours.
    const href = canSwitch ? gate.settingsHref : null;
    return (
      <LockedFeature
        feature="delivery"
        description={href ? what : `${what} ${t('lockedFeature.deliveryAskToSwitchOn')}`}
        action={href ? { href, label: t('lockedFeature.deliveryOpenSettings') } : undefined}
      />
    );
  }
  return (
    <LockedFeature
      feature="delivery"
      description={
        named
          ? t('lockedFeature.deliveryNotAvailableAtBranch', { branch: named })
          : t('lockedFeature.deliveryNotAvailableHere')
      }
    />
  );
}

/**
 * The line a delivery screen carries while it is still open only because work is
 * outstanding: runs a rider has not finished, or money a rider is still owed.
 *
 * Locking those screens outright would strand that work, which the packaging forbids
 * (docs/PACKAGING-2026-10-24.md §3), so they stay usable and say why they are still here —
 * and, where the merchant switched delivery off, where to switch it back on.
 */
export async function DeliveryStoppedNotice({
  branchName,
  gate,
  canSwitch,
  body,
}: {
  branchName: string;
  gate: DeliveryGate;
  /** branch.settings here: may open the switch. */
  canSwitch: boolean;
  /** Already translated by the caller — each screen has outstanding work of its own kind. */
  body: string;
}) {
  const t = await getTranslations('misc');
  const named = branchName.trim();
  const href = gate.reason === 'switchedOff' && canSwitch ? gate.settingsHref : null;
  const after =
    gate.reason === 'switchedOff'
      ? href
        ? null
        : t('lockedFeature.deliveryAskToSwitchOn')
      : t('lockedFeature.deliveryStoppedNotAvailable');
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
            <span className="text-muted-foreground">{body}</span>
            {after && <span className="text-muted-foreground"> {after}</span>}
            {href && (
              <>
                {' '}
                <Link
                  href={href}
                  className="focus-ring font-medium text-primary underline-offset-2 hover:underline"
                >
                  {t('lockedFeature.deliveryTurnBackOn')}
                </Link>
              </>
            )}
          </span>
        </p>
      </Card>
    </div>
  );
}
