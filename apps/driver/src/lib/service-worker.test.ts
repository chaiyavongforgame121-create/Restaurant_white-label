// public/sw.js is a plain script with no imports, so it is run here in a sandbox with a stand-in
// `self`, and its push and message handlers are fed the events a browser would send.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

interface Shown {
  title: string;
  tag?: string;
  data?: Record<string, unknown>;
  closed: boolean;
  options: Record<string, unknown>;
  close: () => void;
}

function loadWorker(now = Date.parse('2026-10-05T15:30:00Z')) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const posted: unknown[] = [];
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    location: { origin: 'https://driver.example' },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        // A notification with the same tag replaces the one on the shade, as browsers do.
        for (const n of shown) if (options.tag && n.tag === options.tag) n.closed = true;
        const n: Shown = {
          title,
          tag: options.tag as string | undefined,
          data: options.data as Record<string, unknown> | undefined,
          options,
          closed: false,
          close: () => {
            n.closed = true;
          },
        };
        shown.push(n);
      },
      getNotifications: async () => shown.filter((n) => !n.closed),
    },
    clients: {
      matchAll: async () => [{ postMessage: (message: unknown) => posted.push(message) }],
      claim: async () => undefined,
    },
    skipWaiting: () => undefined,
  };
  const FakeDate = class extends Date {
    static override now() {
      return now;
    }
  };
  vm.runInNewContext(SOURCE, { self, caches: {}, fetch: () => undefined, Response, URL, Date: FakeDate, isFinite, Number, Array });

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  const push = (payload: unknown) => dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  const message = (data: unknown) => dispatch('message', { data });
  const open = () => shown.filter((n) => !n.closed);
  return { dispatch, push, message, shown, open, posted, now };
}

describe('driver service worker: offers', () => {
  it('bumps the cache version so installed phones take this worker', () => {
    expect(SOURCE).toMatch(/const CACHE_VERSION = 'favornoms-driver-v5'/);
  });

  it('shows an offer that alerts, and tells the open app about it', async () => {
    const w = loadWorker();
    await w.push({ title: 'New delivery offer', body: '2.1 mi', url: '/app/home', tag: 'new_dispatch:d1' });
    expect(w.open()).toHaveLength(1);
    const [n] = w.open();
    expect(n!.options).toMatchObject({ requireInteraction: true, renotify: true, silent: false });
    expect(n!.data).toMatchObject({ url: '/app/home', deliveryId: 'd1', offer: true });
    expect(w.posted).toEqual([{ type: 'push', tag: 'new_dispatch:d1', deliveryId: 'd1', offer: true }]);
  });

  it('closes offer notifications the app reports are no longer live', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1' });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2' });
    await w.push({ title: 'Order ready', tag: 'order_ready_pickup:o9' });
    await w.message({ type: 'offers-live', deliveryIds: ['d2'] });
    expect(w.open().map((n) => n.tag)).toEqual(['new_dispatch:d2', 'order_ready_pickup:o9']);
    await w.message({ type: 'offers-live', deliveryIds: [] });
    expect(w.open().map((n) => n.tag)).toEqual(['order_ready_pickup:o9']);
  });

  it('ignores messages that are not ours', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1' });
    await w.message({ type: 'offers-live' });
    await w.message({ type: 'something-else', deliveryIds: [] });
    await w.message(null);
    expect(w.open()).toHaveLength(1);
  });

  it('closes an offer when a later push for the same delivery says it is over', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1' });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2' });
    await w.push({ title: 'Offer withdrawn', tag: 'offer_gone:d1', delivery_id: 'd1', offer_gone: 'd1' });
    expect(w.open().map((n) => n.tag)).toEqual(['new_dispatch:d2', 'offer_gone:d1']);
  });

  it('closes expired offers at the next push, from the deadline the payload carried', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: new Date(w.now - 1_000).toISOString() });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2', expires_at: new Date(w.now + 60_000).toISOString() });
    // d1 reached the phone already lapsed: shown (a push must show something), but quietly.
    const d1 = w.shown.find((n) => n.tag === 'new_dispatch:d1')!;
    expect(d1.options).toMatchObject({ silent: true, requireInteraction: false, renotify: false });
    expect(w.open().map((n) => n.tag)).toEqual(['new_dispatch:d2']);
  });

  it('keeps non-offer pushes as they were: they alert briefly and do not stay up', async () => {
    const w = loadWorker();
    await w.push({ title: 'New message', body: 'Hi', tag: 'new_message:o1' });
    const [n] = w.open();
    expect(n!.options).toMatchObject({ requireInteraction: false, silent: false, vibrate: [100] });
    expect(w.posted).toEqual([{ type: 'push', tag: 'new_message:o1', deliveryId: null, offer: false }]);
  });

  it('still shows a notification for a payload that is not JSON, or is empty', async () => {
    const w = loadWorker();
    await w.dispatch('push', {
      data: {
        json: () => {
          throw new SyntaxError('Unexpected token');
        },
        text: () => 'plain text',
      },
    });
    await w.push(null);
    expect(w.open().map((n) => [n.title, n.options.body])).toEqual([
      ['FavorGO', 'plain text'],
      ['FavorGO', ''],
    ]);
  });
});
