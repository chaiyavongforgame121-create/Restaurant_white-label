'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DriverStatus = 'offline' | 'online' | 'on_delivery' | 'cooldown';

interface DriverState {
  status: DriverStatus;
  /** branch_id -> online for THIS branch (server truth, cached). */
  branchOnline: Record<string, boolean>;
  toggle: () => void;
  setStatus: (status: DriverStatus) => void;
  setBranchOnline: (branchId: string, online: boolean) => void;
  setBranchAvailability: (map: Record<string, boolean>) => void;
}

export const useDriver = create<DriverState>()(
  persist(
    (set, get) => ({
      status: 'offline',
      branchOnline: {},
      toggle: () =>
        set({ status: get().status === 'offline' ? 'online' : 'offline' }),
      setStatus: (status) => set({ status }),
      setBranchOnline: (branchId, online) =>
        set((s) => ({ branchOnline: { ...s.branchOnline, [branchId]: online } })),
      setBranchAvailability: (map) => set({ branchOnline: map }),
    }),
    { name: 'favornoms-driver-v2' },
  ),
);
