'use client';

import * as React from 'react';
import { getBrowserClient } from '@favornoms/database/client';
import {
  acceptDispatch as acceptDispatchQuery,
  rejectDispatch as rejectDispatchQuery,
  progressDelivery as progressDeliveryQuery,
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
  assignedAt: string | null;
}

interface DeliveryContextValue {
  /** A new offer that has not been accepted yet. */
  offered: ActiveDeliveryUI | null;
  /** The delivery currently in flight (accepted, picked_up, in_transit). */
  active: ActiveDeliveryUI | null;
  accept: () => Promise<void>;
  reject: (reason?: 'timeout' | 'declined') => Promise<void>;
  progress: (next: DeliveryStatus) => Promise<void>;
}

const DeliveryContext = React.createContext<DeliveryContextValue | null>(null);

const acceptedStorageKey = (driverId: string) => `favornoms-driver-accepted-${driverId}`;

function readAcceptedSet(driverId: string): Set<string> {
  if (typeof window === 'undefined') return new Set();
  try {
    const raw = window.localStorage.getItem(acceptedStorageKey(driverId));
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}

function writeAcceptedSet(driverId: string, set: Set<string>) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(acceptedStorageKey(driverId), JSON.stringify([...set]));
}

function mapDeliveryToUI(row: Record<string, unknown>): ActiveDeliveryUI {
  const order = row.order as {
    id: string;
    order_number: string;
    customer_name: string;
    customer_phone: string | null;
    delivery_address: { line1?: string } | null;
    customer_notes: string | null;
    order_items?: { item_name: string; quantity: number }[];
  };
  const branch = row.branch as { name: string; address: string };

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
    assignedAt: (row.assigned_at as string | null) ?? null,
  };
}

export function DeliveryProvider({ children }: { children: React.ReactNode }) {
  const { driver } = useDriverSession();
  const driverId = driver.id;

  const [offered, setOffered] = React.useState<ActiveDeliveryUI | null>(null);
  const [active, setActive] = React.useState<ActiveDeliveryUI | null>(null);
  const acceptedRef = React.useRef<Set<string>>(readAcceptedSet(driverId));

  const refreshFromServer = React.useCallback(async () => {
    const supabase = getBrowserClient();
    const row = await getActiveDelivery(supabase, driverId);
    if (!row) {
      setOffered(null);
      setActive(null);
      return;
    }
    const ui = mapDeliveryToUI(row as unknown as Record<string, unknown>);
    if (ui.status === 'assigned' && !acceptedRef.current.has(ui.id)) {
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

  const accept = React.useCallback(async () => {
    if (!offered) return;
    const supabase = getBrowserClient();
    const { error } = await acceptDispatchQuery(supabase, offered.id);
    if (error) {
      // Offer expired or was reassigned (no longer 'assigned' to this driver):
      // accept_dispatch raises 'forbidden'. Clear the stale offer and resync from
      // the server rather than silently leaving the driver with nothing.
      setOffered(null);
      void refreshFromServer();
      return;
    }
    acceptedRef.current.add(offered.id);
    writeAcceptedSet(driverId, acceptedRef.current);
    setActive(offered);
    setOffered(null);
  }, [offered, driverId, refreshFromServer]);

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
      await progressDeliveryQuery(supabase, active.id, next);
      if (next === 'delivered') {
        acceptedRef.current.delete(active.id);
        writeAcceptedSet(driverId, acceptedRef.current);
        setActive(null);
      } else {
        setActive({ ...active, status: next });
      }
    },
    [active, driverId],
  );

  return (
    <DeliveryContext.Provider value={{ offered, active, accept, reject, progress }}>
      {children}
    </DeliveryContext.Provider>
  );
}

export function useDelivery() {
  const ctx = React.useContext(DeliveryContext);
  if (!ctx) throw new Error('useDelivery must be used inside <DeliveryProvider>');
  return ctx;
}
