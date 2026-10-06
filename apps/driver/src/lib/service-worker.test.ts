// public/sw.js is a plain script with no imports, so it is run here in a sandbox with a stand-in
// `self`, and its push and message handlers are fed the events a browser would send.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = fs.readFileSync(path.resolve(__dirname, '../../public/sw.js'), 'utf8');

const T0 = Date.parse('2026-10-05T15:30:00Z');

interface Shown {
  title: string;
  tag?: string;
  data?: Record<string, unknown>;
  closed: boolean;
  options: Record<string, unknown>;
  close: () => void;
}

/** Cache Storage as far as the worker uses it, kept outside one worker so a restart can see it. */
function fakeCaches() {
  const stores = new Map<string, Map<string, string>>();
  const open = async (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name)!;
    return {
      match: async (key: string) => (store.has(key) ? new Response(store.get(key)) : undefined),
      put: async (key: string, res: Response) => {
        store.set(key, await res.text());
      },
    };
  };
  return {
    stores,
    api: {
      open,
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
    },
  };
}

interface WorkerOptions {
  now?: number;
  /** Shared between workers to stand for the same phone's storage across a worker restart. */
  caches?: ReturnType<typeof fakeCaches>;
  /** How many showNotification calls fail before they work (a browser that refuses the options). */
  failShows?: number;
}

function loadWorker({ now = T0, caches = fakeCaches(), failShows = 0 }: WorkerOptions = {}) {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: Shown[] = [];
  const posted: unknown[] = [];
  let failuresLeft = failShows;
  const self = {
    addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn),
    location: { origin: 'https://driver.example' },
    registration: {
      showNotification: async (title: string, options: Record<string, unknown>) => {
        // What Chromium refuses, as it refuses it: with a TypeError, so nothing is shown.
        if (options.silent && options.vibrate !== undefined) {
          throw new TypeError('Silent notifications must not specify vibration patterns.');
        }
        if (options.renotify && !options.tag) {
          throw new TypeError('Notifications which set the renotify flag must specify a non-empty tag.');
        }
        if (failuresLeft > 0) {
          failuresLeft -= 1;
          throw new TypeError('Refused');
        }
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
  const clock = { now };
  const FakeDate = class extends Date {
    static override now() {
      return clock.now;
    }
  };
  vm.runInNewContext(SOURCE, {
    self,
    caches: caches.api,
    fetch: () => undefined,
    Response,
    URL,
    Date: FakeDate,
    isFinite,
    Number,
    Array,
  });

  const dispatch = async (type: string, event: Record<string, unknown>) => {
    const pending: Promise<unknown>[] = [];
    handlers.get(type)!({ ...event, waitUntil: (p: Promise<unknown>) => pending.push(p) });
    await Promise.all(pending);
  };
  const push = (payload: unknown) => dispatch('push', { data: { json: () => payload, text: () => JSON.stringify(payload) } });
  const message = (data: unknown) => dispatch('message', { data });
  const open = () => shown.filter((n) => !n.closed);
  return { dispatch, push, message, shown, open, posted, now, clock, caches };
}

const iso = (ms: number) => new Date(ms).toISOString();

describe('driver service worker: offers', () => {
  it('bumps the cache version so installed phones take this worker', () => {
    expect(SOURCE).toMatch(/const CACHE_VERSION = 'favornoms-driver-v6'/);
  });

  it('shows an offer that alerts, and tells the open app about it', async () => {
    const w = loadWorker();
    await w.push({ title: 'New delivery offer', body: '2.1 mi', url: '/app/home', tag: 'new_dispatch:d1' });
    expect(w.open()).toHaveLength(1);
    const [n] = w.open();
    expect(n!.options).toMatchObject({ requireInteraction: true, renotify: true, silent: false });
    expect(n!.options.vibrate).toEqual([200, 100, 200, 100, 200]);
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
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(w.now - 1_000) });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2', expires_at: iso(w.now + 60_000) });
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

describe('driver service worker: a lapsed offer push (v5 threw on it)', () => {
  it('shows it quietly, with no vibration pattern beside silent, and still tells the open app', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(w.now - 5_000) });
    expect(w.open()).toHaveLength(1);
    const [n] = w.open();
    expect(n!.options).toMatchObject({ silent: true, requireInteraction: false, renotify: false });
    expect(n!.options).not.toHaveProperty('vibrate');
    expect(w.posted).toEqual([{ type: 'push', tag: 'new_dispatch:d1', deliveryId: 'd1', offer: true }]);
  });

  it('counts an offer with under two seconds left as lapsed: nobody can answer it in time', async () => {
    const w = loadWorker();
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(w.now + 1_500) });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2', expires_at: iso(w.now + 2_500) });
    const byTag = (tag: string) => w.shown.find((n) => n.tag === tag)!.options;
    expect(byTag('new_dispatch:d1')).toMatchObject({ silent: true, requireInteraction: false });
    expect(byTag('new_dispatch:d2')).toMatchObject({ silent: false, requireInteraction: true });
  });

  it('falls back to plain options when the browser refuses the first set, and the app is told either way', async () => {
    const w = loadWorker({ failShows: 1 });
    await w.push({ title: 'New delivery offer', body: '2.1 mi', tag: 'new_dispatch:d1', expires_at: iso(w.now + 60_000) });
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]!.options).toMatchObject({ body: '2.1 mi', tag: 'new_dispatch:d1' });
    expect(w.open()[0]!.data).toMatchObject({ deliveryId: 'd1', offer: true });

    const failing = loadWorker({ failShows: 2 });
    await failing.push({ title: 'Offer', tag: 'new_dispatch:d2' });
    expect(failing.open()).toHaveLength(0);
    expect(failing.posted).toEqual([{ type: 'push', tag: 'new_dispatch:d2', deliveryId: 'd2', offer: true }]);
  });
});

describe('driver service worker: an offer answered in the app before its push arrived', () => {
  const deadline = T0 + 60_000;

  it('shows the late push silently and closes it at once', async () => {
    const w = loadWorker();
    // The rider declined d1 in the app; its push was still on the way.
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline }] });
    await w.push({ title: 'New delivery offer', tag: 'new_dispatch:d1', expires_at: iso(deadline) });
    const d1 = w.shown.find((n) => n.tag === 'new_dispatch:d1')!;
    expect(d1.options).toMatchObject({ silent: true, requireInteraction: false, renotify: false });
    expect(d1.options).not.toHaveProperty('vibrate');
    expect(w.open()).toHaveLength(0);
    // The open app still hears of it, and its read settles the rest.
    expect(w.posted).toEqual([{ type: 'push', tag: 'new_dispatch:d1', deliveryId: 'd1', offer: true }]);
  });

  it('remembers across a worker restart (the push comes after the idle worker was stopped)', async () => {
    const storage = fakeCaches();
    const before = loadWorker({ caches: storage });
    await before.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline }] });
    const after = loadWorker({ caches: storage, now: T0 + 40_000 });
    await after.push({ title: 'New delivery offer', tag: 'new_dispatch:d1', expires_at: iso(deadline) });
    expect(after.open()).toHaveLength(0);
  });

  it('matches a deadline read at a different precision (database microseconds, push milliseconds)', async () => {
    const w = loadWorker();
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline + 456 }] });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(deadline) });
    expect(w.open()).toHaveLength(0);
  });

  it('still rings for the same delivery offered again later, under a new deadline', async () => {
    const w = loadWorker();
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline }] });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(deadline + 300_000) });
    expect(w.open()).toHaveLength(1);
    expect(w.open()[0]!.options).toMatchObject({ silent: false, requireInteraction: true });
  });

  it('leaves other offers alone, and forgets an answered offer after a while', async () => {
    const w = loadWorker();
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline }] });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d2', expires_at: iso(deadline) });
    expect(w.open().map((n) => n.tag)).toEqual(['new_dispatch:d2']);
    // Long after any push for it could arrive, the entry is gone: the same push now stays up
    // (quietly, its deadline being long past).
    w.clock.now = T0 + 16 * 60_000;
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(deadline) });
    expect(w.open().map((n) => n.tag)).toContain('new_dispatch:d1');
  });

  it('matches an offer without a deadline by delivery, but only briefly', async () => {
    const w = loadWorker();
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: null }] });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1' });
    expect(w.open()).toHaveLength(0);
    w.clock.now = T0 + 3 * 60_000;
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1' });
    expect(w.open()).toHaveLength(1);
  });

  it('ignores a malformed report of offers that are over', async () => {
    const w = loadWorker();
    await w.message({ type: 'offers-live', deliveryIds: [], over: [null, { deliveryId: 7 }, 'd1', { expiresAt: deadline }] });
    await w.push({ title: 'Offer', tag: 'new_dispatch:d1', expires_at: iso(deadline) });
    expect(w.open()).toHaveLength(1);
  });

  it('keeps the list when the worker is replaced by a new version', async () => {
    const storage = fakeCaches();
    const w = loadWorker({ caches: storage });
    await w.message({ type: 'offers-live', deliveryIds: [], over: [{ deliveryId: 'd1', expiresAt: deadline }] });
    storage.stores.set('favornoms-driver-v5', new Map());
    await w.dispatch('activate', {});
    expect([...storage.stores.keys()]).toEqual(['favornoms-driver-offers-over']);
  });
});
