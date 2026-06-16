'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  acceptDispatch as acceptDispatchQuery,
  rejectDispatch as rejectDispatchQuery,
  progressDelivery as progressDeliveryQuery,
  markDeliveryArriving as markArrivingQuery,
  getActiveDelivery,
  type DeliveryStatus,
} from '@favornoms/database/queries';
import { useDriverSession } from './driver-session';

/**
 * A merged delivery + order + branch payload that the UI consumes.
 */
export interface ActiveDeliveryUI {
  id: string;
  orderId: string;
  orderNumber: string;
  status: DeliveryStatus;
  distanceKm: number;
  estimatedDurationMin: number;
  driverEarnings: number;
  branchName: string;
  branchAddress: string;
  customerName: string;
  customerAddress: string;
  customerPhone: string | null;
  itemsSummary: string;
  customerNotes: string | null;
  /** Free-form delivery instructions the customer entered (gate code, room, "leave at door"…). */
  dropoffNotes: string | null;
  assignedAt: string | null;
  /** Stamped by accept_dispatch — null while the job is still just an offer. */
  acceptedAt: string | null;
  /** Server-side offer deadline (dispatch v2) — drives the countdown. */
  offerExpiresAt: string | null;
  branchLat: number | null;
  branchLng: number | null;
  dropoffLat: number | null;
  dropoffLng: number | null;
}

interface DeliveryContextValue {
  /** A new offer that has not been accepted yet. */
  offered: ActiveDeliveryUI | null;
  /** The delivery currently in flight (accepted, picked_up, in_transit). */
  active: ActiveDeliveryUI | null;
  accept: () => Promise<boolean>;
  reject: (reason?: 'timeout' | 'declined') => Promise<void>;
  progress: (next: DeliveryStatus) => Promise<void>;
  /** Persist "arrived at the customer" (sets arriving_at). */
  markArriving: () => Promise<void>;
}

const DeliveryContext = React.createContext<DeliveryContextValue | null>(null);

function mapDeliveryToUI(row: Record<string, unknown>): ActiveDeliveryUI {
  const order = row.order as {
    id: string;
    order_number: string;
    customer_name: string;
    customer_phone: string | null;
    delivery_address: { line1?: string; notes?: string } | null;
    customer_notes: string | null;
    order_items?: { item_name: string; quantity: number }[];
  };
  const branch = row.branch as {
    name: string;
    address: string;
    geo_lat?: number | null;
    geo_lng?: number | null;
  };

  const itemsSummary = (order.order_items ?? [])
    .map((i) => `${i.quantity}× ${i.item_name}`)
    .join(' · ');

  return {
    id: row.id as string,
    orderId: order.id,
    orderNumber: order.order_number,
    status: row.status as DeliveryStatus,
    distanceKm: (row.distance_km as number) ?? 0,
    estimatedDurationMin: (row.estimated_duration_min as number) ?? 0,
    driverEarnings: (row.driver_earnings as number) ?? 0,
    branchName: branch?.name ?? 'Restaurant',
    branchAddress: branch?.address ?? '',
    customerName: order.customer_name,
    customerAddress: order.delivery_address?.line1 ?? '',
    customerPhone: order.customer_phone ?? null,
    itemsSummary: itemsSummary || `${order.order_number}`,
    customerNotes: order.customer_notes ?? null,
    dropoffNotes: order.delivery_address?.notes ?? null,
    assignedAt: (row.assigned_at as string | null) ?? null,
    acceptedAt: (row.accepted_at as string | null) ?? null,
    offerExpiresAt: (row.offer_expires_at as string | null) ?? null,
    branchLat: branch?.geo_lat ?? null,
    branchLng: branch?.geo_lng ?? null,
    dropoffLat: (row.dropoff_lat as number | null) ?? null,
    dropoffLng: (row.dropoff_lng as number | null) ?? null,
  };
}

export function DeliveryProvider({ children }: { children: React.ReactNode }) {
  const { driver } = useDriverSession();
  const driverId = driver.id;

  const [offered, setOffered] = React.useState<ActiveDeliveryUI | null>(null);
  const [active, setActive] = React.useState<ActiveDeliveryUI | null>(null);

  const refreshFromServer = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const row = await getActiveDelivery(supabase, driverId);
    if (!row) {
      setOffered(null);
      setActive(null);
      return;
    }
    const ui = mapDeliveryToUI(row as unknown as Record<string, unknown>);
    // accepted_at is the server-side acceptance signal (stamped by
    // accept_dispatch) — 'assigned' without it means a pending offer.
    if (ui.status === 'assigned' && !ui.acceptedAt) {
      setOffered(ui);
      setActive(null);
    } else {
      setOffered(null);
      setActive(ui);
    }
  }, [driverId]);

  React.useEffect(() => {
    void refreshFromServer();
    const supabase = getBrowserClient();
    const channel = supabase
      .channel(`driver-deliveries-${driverId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'deliveries',
          filter: `driver_id=eq.${driverId}`,
        },
        () => {
          void refreshFromServer();
        },
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [driverId, refreshFromServer]);

  const accept = React.useCallback(async (): Promise<boolean> => {
    if (!offered) return false;
    const supabase = getBrowserClient();
    const { error } = await acceptDispatchQuery(supabase, offered.id);
    if (error) {
      // Offer expired or was reassigned (no longer 'assigned' to this driver):
      // accept_dispatch raises 'forbidden'. Clear the stale offer and resync from
      // the server rather than silently leaving the driver with nothing.
      setOffered(null);
      void refreshFromServer();
      return false;
    }
    setActive({ ...offered, acceptedAt: new Date().toISOString() });
    setOffered(null);
    return true;
  }, [offered, refreshFromServer]);

  const reject = React.useCallback(
    async (reason: 'timeout' | 'declined' = 'declined') => {
      if (!offered) return;
      const supabase = getBrowserClient();
      await rejectDispatchQuery(supabase, offered.id, driverId, reason);
      setOffered(null);
    },
    [offered, driverId],
  );

  const progress = React.useCallback(
    async (next: DeliveryStatus) => {
      if (!active) return;
      const supabase = getBrowserClient();
      const { error } = await progressDeliveryQuery(supabase, active.id, next);
      if (error) {
        // The guarded progress_delivery RPC rejected the transition (illegal move,
        // concurrent cancel/reassign, RLS). Resync from the server instead of faking
        // an advance, and let the caller surface the failure (no false "completed").
        void refreshFromServer();
        throw new Error(error.message ?? 'progress_failed');
      }
      if (next === 'delivered') {
        setActive(null);
      } else {
        setActive({ ...active, status: next });
      }
    },
    [active, refreshFromServer],
  );

  const markArriving = React.useCallback(async () => {
    if (!active) return;
    const supabase = getBrowserClient();
    await markArrivingQuery(supabase, active.id);
  }, [active]);

  return (
    <DeliveryContext.Provider value={{ offered, active, accept, reject, progress, markArriving }}>
      {children}
    </DeliveryContext.Provider>
  );
}

export function useDelivery() {
  const ctx = React.useContext(DeliveryContext);
  if (!ctx) throw new Error('useDelivery must be used inside <DeliveryProvider>');
  return ctx;
}
