'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DriverStatus = 'offline' | 'online' | 'on_delivery' | 'cooldown';

interface DriverState {
  status: DriverStatus;
  toggle: () => void;
  setStatus: (status: DriverStatus) => void;
}

export const useDriver = create<DriverState>()(
  persist(
    (set, get) => ({
      status: 'offline',
      toggle: () =>
        set({ status: get().status === 'offline' ? 'online' : 'offline' }),
      setStatus: (status) => set({ status }),
    }),
    { name: 'favornoms-driver-v2' },
  ),
);
