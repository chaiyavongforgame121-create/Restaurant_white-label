'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DriverStatus = 'offline' | 'online' | 'on_delivery' | 'cooldown';

/**
 * What the location ping is actually managing to do right now.
 *
 * 'unknown' until the first callback of either kind lands. Everything else comes from a
 * geolocation error code, which the ping used to throw away — so a rider whose browser had
 * blocked location read "You're online · Ready to receive orders" while dispatch, which
 * refuses anyone whose fix is older than dispatch_max_gps_age_min, could never offer them a
 * job. Silently unofferable is the worst state this app can put a rider in.
 */
export type GpsState = 'unknown' | 'ok' | 'denied' | 'unavailable' | 'insecure';

interface DriverState {
  status: DriverStatus;
  /** branch_id -> online for THIS branch (server truth, cached). */
  branchOnline: Record<string, boolean>;
  /** Remembered "go online" scope: the branch ids the rider wants offers from.
   *  Empty = not chosen yet → treated as "all approved". Persisted so one tap
   *  re-goes-online for the same restaurants. */
  scope: string[];
  /** Live GPS health, reported by DriverLocationPing. Never persisted. */
  gps: GpsState;
  /** Date.now() of the last fix this device actually wrote. Never persisted. */
  lastFixAt: number | null;
  toggle: () => void;
  setStatus: (status: DriverStatus) => void;
  setBranchOnline: (branchId: string, online: boolean) => void;
  setBranchAvailability: (map: Record<string, boolean>) => void;
  setScope: (ids: string[]) => void;
  setGps: (gps: GpsState) => void;
  markFixSent: () => void;
}

export const useDriver = create<DriverState>()(
  persist(
    (set, get) => ({
      status: 'offline',
      branchOnline: {},
      scope: [],
      gps: 'unknown',
      lastFixAt: null,
      toggle: () =>
        set({ status: get().status === 'offline' ? 'online' : 'offline' }),
      setStatus: (status) => set({ status }),
      setBranchOnline: (branchId, online) =>
        set((s) => ({ branchOnline: { ...s.branchOnline, [branchId]: online } })),
      setBranchAvailability: (map) => set({ branchOnline: map }),
      setScope: (ids) => set({ scope: ids }),
      setGps: (gps) => set((s) => (s.gps === gps ? s : { gps })),
      markFixSent: () => set({ gps: 'ok', lastFixAt: Date.now() }),
    }),
    {
      name: 'favornoms-driver-v2',
      // GPS health is a property of this phone in this moment. Restoring yesterday's 'ok'
      // from localStorage would put the "you are being seen" banner back on screen before
      // the first fix of the shift has been taken.
      partialize: (s) => ({ status: s.status, branchOnline: s.branchOnline, scope: s.scope }),
    },
  ),
);
