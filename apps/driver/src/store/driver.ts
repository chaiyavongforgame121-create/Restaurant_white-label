'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DriverStatus = 'offline' | 'online' | 'on_delivery' | 'cooldown';

interface DriverState {
  status: DriverStatus;
  /** branch_id -> online for THIS branch (server truth, cached). */
  branchOnline: Record<string, boolean>;
  /** Remembered "go online" scope: the branch ids the rider wants offers from.
   *  Empty = not chosen yet → treated as "all approved". Persisted so one tap
   *  re-goes-online for the same restaurants. */
  scope: string[];
  toggle: () => void;
  setStatus: (status: DriverStatus) => void;
  setBranchOnline: (branchId: string, online: boolean) => void;
  setBranchAvailability: (map: Record<string, boolean>) => void;
  setScope: (ids: string[]) => void;
}

export const useDriver = create<DriverState>()(
  persist(
    (set, get) => ({
      status: 'offline',
      branchOnline: {},
      scope: [],
      toggle: () =>
        set({ status: get().status === 'offline' ? 'online' : 'offline' }),
      setStatus: (status) => set({ status }),
      setBranchOnline: (branchId, online) =>
        set((s) => ({ branchOnline: { ...s.branchOnline, [branchId]: online } })),
      setBranchAvailability: (map) => set({ branchOnline: map }),
      setScope: (ids) => set({ scope: ids }),
    }),
    { name: 'favornoms-driver-v2' },
  ),
);
