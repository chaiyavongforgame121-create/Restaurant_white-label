'use client';

import * as React from 'react';
import { readOnOff } from './alerts';

/**
 * Switches that belong to this phone, not to the rider's account: a rider with a work phone and
 * a personal one may well want the offer ring on one and not the other. Kept in localStorage.
 *
 * Storage can be missing or throw (private mode, blocked site data). Every read falls back to the
 * last value set in this visit, then to the default, and every write is best-effort: the app
 * behaves the same, it just forgets on reload.
 */
export type DevicePref = 'sound' | 'keepAwake';

const STORAGE_KEY: Record<DevicePref, string> = {
  sound: 'favorgo:sound',
  keepAwake: 'favorgo:keep-awake',
};

/** Both on: an offer that cannot be heard, or a screen that locks while waiting, loses work. */
const DEFAULT: Record<DevicePref, boolean> = { sound: true, keepAwake: true };

const memory: Partial<Record<DevicePref, boolean>> = {};
const listeners = new Set<() => void>();

export function readDevicePref(pref: DevicePref): boolean {
  try {
    return readOnOff(window.localStorage.getItem(STORAGE_KEY[pref]), memory[pref] ?? DEFAULT[pref]);
  } catch {
    return memory[pref] ?? DEFAULT[pref];
  }
}

export function writeDevicePref(pref: DevicePref, on: boolean): void {
  memory[pref] = on;
  try {
    window.localStorage.setItem(STORAGE_KEY[pref], on ? 'on' : 'off');
  } catch {
    /* not persisted; this visit still behaves */
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // Another tab of the app changing it (rare in an installed app, common while testing).
  const onStorage = (event: StorageEvent) => {
    if (event.key == null || Object.values(STORAGE_KEY).includes(event.key)) listener();
  };
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

/** A device switch and its setter, shared live by every component that shows or obeys it. The
 *  server render (and the first client render) use the default, so hydration agrees. */
export function useDevicePref(pref: DevicePref): [boolean, (on: boolean) => void] {
  const value = React.useSyncExternalStore(
    subscribe,
    () => readDevicePref(pref),
    () => DEFAULT[pref],
  );
  const set = React.useCallback((on: boolean) => writeDevicePref(pref, on), [pref]);
  return [value, set];
}
