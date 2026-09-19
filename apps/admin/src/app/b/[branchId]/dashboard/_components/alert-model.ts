// What counts as "new" on Action Required, without React, storage or timers. The hook in
// use-action-alerts.ts owns those; every decision it makes is one of these functions, so the
// rules can be read (and tested) in one place.
//
// A row is identified by its bucket and its own key ('kitchen-late:<order id>'), so the same
// order turning up in a second bucket — accepted, then running late — is a new thing to look at,
// while the same booking moving from "Not accepted" to "Accepted" inside one bucket is not.

/** What the alert watches in one bucket. Built by the page from the same rows it lists. */
export interface WatchedBucket {
  id: string;
  /**
   * False when the read failed or the bucket is out of scope. Its keys then say nothing about
   * what arrived: a read that fails and recovers would otherwise announce every row it holds.
   */
  ok: boolean;
  /** Every row key the page read for this bucket, listed or not. */
  keys: readonly string[];
  /** Everything that matches, which can be more than the keys read. */
  total: number;
}

/** What one tab remembers between renders and between visits (sessionStorage). */
export interface SeenMemory {
  /** Scoped keys that have been on screen this tab session, oldest first. */
  keys: string[];
  /** Buckets that have been read successfully at least once; only their arrivals count. */
  buckets: string[];
  /** Each bucket's `total` at the last snapshot, for buckets whose keys are capped. */
  totals: Record<string, number>;
  /** Keys still flagged new when this was written, restored after a reload without re-alerting. */
  fresh: string[];
}

/**
 * Enough for a long shift of turnover. A soft cap: the keys on screen now are never dropped,
 * even when there are more of them than this.
 */
export const SEEN_CAP = 600;
/**
 * How long a new row stays flagged once the page is actually visible. The clock does not run
 * while the tab is hidden, so an alert that lands while the owner is on another screen is still
 * there when they come back.
 */
export const FRESH_VISIBLE_MS = 3 * 60_000;

export function scopedKey(bucketId: string, rowKey: string): string {
  return `${bucketId}:${rowKey}`;
}

/** The bucket a scoped key belongs to. Bucket ids never contain ':'; row keys may. */
export function bucketOfKey(key: string): string {
  const at = key.indexOf(':');
  return at < 0 ? key : key.slice(0, at);
}

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

/**
 * Stored memory, or null for anything that is not one. Storage is written by this code but read
 * back from a place a browser extension or an older build can also have written, so it is checked
 * rather than trusted; a bad value costs one silent baseline, never a false alarm.
 */
export function parseSeen(raw: string | null): SeenMemory | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.v !== 1 || !isStringArray(o.keys) || !isStringArray(o.buckets)) return null;
  const totals: Record<string, number> = {};
  if (o.totals && typeof o.totals === 'object') {
    for (const [id, n] of Object.entries(o.totals as Record<string, unknown>)) {
      if (typeof n === 'number' && Number.isFinite(n)) totals[id] = n;
    }
  }
  return {
    keys: o.keys,
    buckets: o.buckets,
    totals,
    fresh: isStringArray(o.fresh) ? o.fresh : [],
  };
}

export function serializeSeen(m: SeenMemory): string {
  return JSON.stringify({ v: 1, ...m });
}

export interface Arrivals {
  /** Scoped keys that were not there before, in page order. */
  arrived: string[];
  /** The buckets they arrived in, in page order, each once. */
  buckets: string[];
  memory: SeenMemory;
}

/**
 * Compare this snapshot with what the tab has already seen.
 *
 * With no memory at all — the first dashboard of this tab session — everything on screen is
 * the baseline and nothing is announced: the owner opening the page is not news. With memory,
 * a row is new when its bucket was read before and its key was not in it.
 *
 * A bucket whose keys are capped (total above the keys read, so only the oldest few are known)
 * cannot tell a new row from one that was merely next in line when an old one was dealt with.
 * There a key only counts as new while the total has also gone up, and at most as many as it
 * rose by. The page reads fifty keys per bucket, so this only bites on a very busy branch.
 */
export function detectArrivals(
  prev: SeenMemory | null,
  current: readonly WatchedBucket[],
  cap: number = SEEN_CAP,
): Arrivals {
  const okNow = current.filter((b) => b.ok);
  const seen = new Set(prev?.keys ?? []);
  const knownBuckets = new Set(prev?.buckets ?? []);
  const arrived: string[] = [];
  const arrivedBuckets: string[] = [];

  if (prev) {
    for (const b of okNow) {
      if (!knownBuckets.has(b.id)) continue;
      let unseen = b.keys.map((k) => scopedKey(b.id, k)).filter((k) => !seen.has(k));
      const capped = b.total > b.keys.length;
      if (capped) {
        const before = prev.totals[b.id];
        const rose = before == null ? 0 : Math.max(0, b.total - before);
        unseen = unseen.slice(0, rose);
      }
      if (unseen.length > 0) {
        arrived.push(...unseen);
        arrivedBuckets.push(b.id);
      }
    }
  }

  // Everything on screen now goes to the end and the cap never cuts into it: a key dropped while
  // it is still showing is announced again on the next refresh, and the one after, every minute.
  // The page can read more keys than the cap on a big enough backlog (every bucket's read limit
  // added up), so on such a day the memory holds what is on screen and forgets everything else.
  const onScreen = okNow.flatMap((b) => b.keys.map((k) => scopedKey(b.id, k)));
  const onScreenSet = new Set(onScreen);
  const kept = (prev?.keys ?? []).filter((k) => !onScreenSet.has(k));
  const keys = [...kept, ...onScreen];
  const room = Math.max(cap, onScreen.length);
  const trimmed = keys.length > room ? keys.slice(keys.length - room) : keys;

  // A bucket that failed this time keeps its place and its last total: when it recovers, rows
  // that really arrived in the meantime are still news, and its old rows are not.
  const buckets = [...new Set([...(prev?.buckets ?? []), ...okNow.map((b) => b.id)])];
  const totals: Record<string, number> = { ...(prev?.totals ?? {}) };
  for (const b of okNow) totals[b.id] = b.total;

  return {
    arrived,
    buckets: arrivedBuckets,
    memory: { keys: trimmed, buckets, totals, fresh: prev?.fresh ?? [] },
  };
}

// ---------------------------------------------------------------------------------------
// Rows flagged new
// ---------------------------------------------------------------------------------------

/**
 * Scoped key → when the page was first visible with it flagged. null while the tab has been
 * hidden the whole time, so the fade clock has not started.
 *
 * Every function below returns the same object when nothing changed, so a timer that finds
 * nothing to do does not re-render the section.
 */
export type FreshMap = Readonly<Record<string, number | null>>;

export function addFresh(
  fresh: FreshMap,
  keys: readonly string[],
  nowMs: number,
  visible: boolean,
): FreshMap {
  const add = keys.filter((k) => !(k in fresh));
  if (add.length === 0) return fresh;
  const next: Record<string, number | null> = { ...fresh };
  for (const k of add) next[k] = visible ? nowMs : null;
  return next;
}

/** The tab has become visible: start the clock on every flag that was waiting for it. */
export function startFreshClocks(fresh: FreshMap, nowMs: number): FreshMap {
  if (!Object.values(fresh).some((v) => v == null)) return fresh;
  const next: Record<string, number | null> = {};
  for (const [k, v] of Object.entries(fresh)) next[k] = v ?? nowMs;
  return next;
}

/** Drop flags that have been visible for `ttlMs`. */
export function expireFresh(
  fresh: FreshMap,
  nowMs: number,
  ttlMs: number = FRESH_VISIBLE_MS,
): FreshMap {
  const keep = Object.entries(fresh).filter(([, since]) => since == null || nowMs - since < ttlMs);
  return keep.length === Object.keys(fresh).length ? fresh : Object.fromEntries(keep);
}

/** Drop the given flags: the row was opened, or the owner said they have seen it. */
export function dropFresh(fresh: FreshMap, keys: readonly string[]): FreshMap {
  const drop = keys.filter((k) => k in fresh);
  if (drop.length === 0) return fresh;
  const next: Record<string, number | null> = { ...fresh };
  for (const k of drop) delete next[k];
  return next;
}

/**
 * Drop flags whose row has left its bucket — dealt with, or moved on. A bucket that could not be
 * read this time keeps its flags: not knowing is not the same as gone.
 */
export function pruneFresh(fresh: FreshMap, current: readonly WatchedBucket[]): FreshMap {
  const readable = new Map(current.filter((b) => b.ok).map((b) => [b.id, new Set(b.keys)]));
  const stale = Object.keys(fresh).filter((k) => {
    const id = bucketOfKey(k);
    const keys = readable.get(id);
    return keys != null && !keys.has(k.slice(id.length + 1));
  });
  return dropFresh(fresh, stale);
}

/** How many flags each bucket carries, for the "2 new" beside its name. */
export function freshPerBucket(fresh: FreshMap): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k of Object.keys(fresh)) {
    const id = bucketOfKey(k);
    out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// The tab title
// ---------------------------------------------------------------------------------------

const COUNT_PREFIX = /^\(\d+\)\s+/;

/**
 * '(3) Favornoms Merchant' while three rows are unseen, the plain title otherwise. Whatever
 * count the title already carries is replaced rather than stacked, because Next rewrites the
 * title after hydration and this is re-applied on top of whatever it wrote.
 */
export function titleWithCount(title: string, count: number): string {
  const base = title.replace(COUNT_PREFIX, '');
  return count > 0 ? `(${count}) ${base}` : base;
}
