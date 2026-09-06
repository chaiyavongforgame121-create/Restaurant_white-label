'use client';

import * as React from 'react';
import { Loader2, UserRound } from 'lucide-react';
import { getBrowserClient } from '@favornoms/database/client';
import type { BranchRider } from '@favornoms/database/queries';
import { Button, Sheet } from '@favornoms/ui';
import { ageLabel, readableRpcError, riderPinState, type RiderPinState } from './live-ops-model';

// Put a named rider on a delivery by hand. This is the way out of a dispatch that never
// finds anyone: auto-dispatch skips riders whose last GPS fix is older than the branch's
// cutoff, while a targeted offer still reaches them — so the riders auto-dispatch gave up
// on are exactly the ones this list has to keep offering.

const STATE_ORDER: Record<RiderPinState, number> = { available: 0, stale: 1, offline: 2, busy: 3 };

const STATE_PILL: Record<RiderPinState, { text: string; className: string }> = {
  available: { text: 'GPS fresh', className: 'bg-success/15 text-success' },
  stale: { text: 'GPS stale', className: 'bg-warning/15 text-warning' },
  offline: { text: 'Offline', className: 'bg-muted text-muted-foreground' },
  busy: { text: 'On a job', className: 'bg-info/15 text-info' },
};

const DOT: Record<RiderPinState, string> = {
  available: 'bg-success',
  stale: 'bg-warning',
  offline: 'bg-muted-foreground/50',
  busy: 'bg-info',
};

export function AssignRiderSheet({
  open,
  onClose,
  deliveryId,
  orderNumber,
  riders,
  maxGpsAgeMin,
  onAssigned,
}: {
  open: boolean;
  onClose: () => void;
  deliveryId: string | null;
  orderNumber: string | null;
  riders: readonly BranchRider[];
  maxGpsAgeMin: number;
  onAssigned: () => void | Promise<void>;
}) {
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  // A stale error from the last rider tried must not greet the next delivery opened.
  React.useEffect(() => {
    if (open) setError(null);
  }, [open, deliveryId]);

  const nowMs = Date.now();
  const ordered = React.useMemo(() => {
    const withState = riders.map((r) => ({ rider: r, state: riderPinState(r, nowMs, maxGpsAgeMin) }));
    return withState.sort(
      (a, b) =>
        STATE_ORDER[a.state] - STATE_ORDER[b.state] ||
        a.rider.full_name.localeCompare(b.rider.full_name),
    );
    // nowMs deliberately excluded: the list only has to be ordered as it was opened, and
    // re-sorting under the pointer moves the row someone is about to press.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [riders, maxGpsAgeMin]);

  const assign = async (driverId: string) => {
    if (!deliveryId) return;
    setBusyId(driverId);
    setError(null);
    const supabase = getBrowserClient();
    const { error: rpcErr } = await supabase.rpc('staff_assign_driver', {
      p_delivery_id: deliveryId,
      p_driver_id: driverId,
    } as never);
    setBusyId(null);
    if (rpcErr) {
      // The RPC raises bare exception names ('driver_busy', 'already_accepted'). Left alone
      // they read as a crash rather than as the rule they are.
      setError(readableRpcError(rpcErr.message));
      return;
    }
    await onAssigned();
    onClose();
  };

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side="right"
      title={orderNumber ? `Assign ${orderNumber} to a rider` : 'Assign to a rider'}
      ariaLabel="Assign to a rider"
      className="w-full max-w-sm"
    >
      <p className="text-sm text-muted-foreground">
        The rider gets a normal offer they can still decline — it just goes to the one you
        pick instead of whoever auto-dispatch scores highest.
      </p>

      {error && (
        <p role="alert" className="mt-3 rounded-xl bg-danger/10 px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      {ordered.length === 0 ? (
        <p className="mt-6 text-sm text-muted-foreground">
          No rider is approved for this branch yet, so there is nobody to offer this to.
        </p>
      ) : (
        <ul className="mt-4 space-y-1">
          {ordered.map(({ rider, state }) => {
            const pill = STATE_PILL[state];
            const blocked =
              state === 'busy'
                ? 'On another delivery'
                : !rider.kyc_verified
                  ? 'Documents not verified'
                  : rider.cooling_down
                    ? 'In a rejection cool-down'
                    : null;
            return (
              <li key={rider.driver_id}>
                <button
                  type="button"
                  disabled={busyId !== null || blocked !== null}
                  onClick={() => void assign(rider.driver_id)}
                  className="focus-ring flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-55"
                >
                  <span className={`h-2 w-2 shrink-0 rounded-full ${DOT[state]}`} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium">{rider.full_name}</span>
                    <span className="block truncate text-xs capitalize text-muted-foreground">
                      {blocked ?? `${rider.vehicle_type} · last seen ${ageLabel(rider.location_updated_at, nowMs)} ago`}
                    </span>
                  </span>
                  {busyId === rider.driver_id ? (
                    <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                  ) : (
                    <span
                      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-semibold ${pill.className}`}
                    >
                      {pill.text}
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="mt-5 flex justify-end">
        <Button variant="ghost" size="sm" onClick={onClose} leftIcon={<UserRound className="h-4 w-4" />}>
          Close
        </Button>
      </div>
    </Sheet>
  );
}
