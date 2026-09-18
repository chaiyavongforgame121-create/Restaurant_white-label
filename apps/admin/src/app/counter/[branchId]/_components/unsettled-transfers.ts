/**
 * QR sales whose order exists but whose payment has not been recorded yet.
 *
 * Such an order waits in "awaiting payment", off the kitchen board, until record_counter_transfer
 * runs. The till used to hold it in React state alone, so a reload, the Dismiss button or a
 * second failed sale lost the only way back to it. It is kept in this browser per branch, the way
 * parked carts are, and Recent orders can settle the same order and clear it from here.
 */

import type { SettleError } from './counter-errors';

export interface UnsettledTransfer<R = unknown> {
  orderId: string;
  orderNumber: string;
  /** When the order was placed (ISO). */
  placedAt: string;
  /** Printed once the payment is recorded; null when the paper would not match the row. */
  receipt: R | null;
  /** Why the last attempt did not record it, or null before anyone has tried again. */
  error: SettleError | null;
}

export const UNSETTLED_STORAGE_KEY = (branchId: string) => `pos-unsettled-transfers:${branchId}`;

const isEntry = (v: unknown): v is UnsettledTransfer =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as UnsettledTransfer).orderId === 'string' &&
  typeof (v as UnsettledTransfer).orderNumber === 'string';

export function readUnsettled<R = unknown>(branchId: string): UnsettledTransfer<R>[] {
  try {
    const raw = window.localStorage.getItem(UNSETTLED_STORAGE_KEY(branchId));
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry).map((e) => ({
      orderId: e.orderId,
      orderNumber: e.orderNumber,
      placedAt: typeof e.placedAt === 'string' ? e.placedAt : new Date().toISOString(),
      receipt: (e.receipt ?? null) as R | null,
      error: e.error ?? null,
    }));
  } catch {
    return [];
  }
}

export function writeUnsettled<R>(branchId: string, list: UnsettledTransfer<R>[]) {
  try {
    if (list.length === 0) window.localStorage.removeItem(UNSETTLED_STORAGE_KEY(branchId));
    else window.localStorage.setItem(UNSETTLED_STORAGE_KEY(branchId), JSON.stringify(list));
  } catch {
    // Storage full or blocked: the order is still on Recent orders.
  }
}

/** Drop one order from the list, once its payment is recorded anywhere. */
export function forgetUnsettled(branchId: string, orderId: string) {
  writeUnsettled(
    branchId,
    readUnsettled(branchId).filter((e) => e.orderId !== orderId),
  );
}
