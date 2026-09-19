import { describe, expect, it } from 'vitest';
import {
  addFresh,
  bucketOfKey,
  detectArrivals,
  dropFresh,
  expireFresh,
  FRESH_VISIBLE_MS,
  freshPerBucket,
  parseSeen,
  pruneFresh,
  scopedKey,
  serializeSeen,
  startFreshClocks,
  titleWithCount,
  type SeenMemory,
  type WatchedBucket,
} from './alert-model';

const NOW = Date.parse('2026-09-19T18:00:00Z');

const bucket = (id: string, keys: string[], over: Partial<WatchedBucket> = {}): WatchedBucket => ({
  id,
  ok: true,
  keys,
  total: keys.length,
  ...over,
});

/** Run a sequence of snapshots through detectArrivals the way the hook does. */
function replay(snapshots: WatchedBucket[][], start: SeenMemory | null = null) {
  let memory = start;
  const arrivals: string[][] = [];
  for (const snap of snapshots) {
    const result = detectArrivals(memory, snap);
    arrivals.push(result.arrived);
    memory = result.memory;
  }
  return { arrivals, memory };
}

describe('detectArrivals', () => {
  it('announces nothing on the first dashboard of a tab session', () => {
    const { arrived, memory } = detectArrivals(null, [
      bucket('scheduled-deliveries', ['o1', 'o2']),
      bucket('proofs', ['p1']),
    ]);
    expect(arrived).toEqual([]);
    expect(memory.keys).toEqual(['scheduled-deliveries:o1', 'scheduled-deliveries:o2', 'proofs:p1']);
    expect(memory.buckets).toEqual(['scheduled-deliveries', 'proofs']);
  });

  it('announces a row that appears while the page is open, once', () => {
    const { arrivals } = replay([
      [bucket('scheduled-deliveries', ['o1'])],
      [bucket('scheduled-deliveries', ['o1', 'o2'])],
      [bucket('scheduled-deliveries', ['o1', 'o2'])],
    ]);
    expect(arrivals).toEqual([[], ['scheduled-deliveries:o2'], []]);
  });

  it('reports which buckets the arrivals landed in, in page order', () => {
    const first = detectArrivals(null, [bucket('proofs', []), bucket('kitchen-late', ['k1'])]);
    const second = detectArrivals(first.memory, [
      bucket('proofs', ['p1']),
      bucket('kitchen-late', ['k1', 'k2']),
    ]);
    expect(second.buckets).toEqual(['proofs', 'kitchen-late']);
  });

  it('counts the same order turning up in a second bucket as new', () => {
    const { arrivals } = replay([
      [bucket('customers-waiting', ['o1']), bucket('kitchen-late', [])],
      [bucket('customers-waiting', []), bucket('kitchen-late', ['o1'])],
    ]);
    expect(arrivals[1]).toEqual(['kitchen-late:o1']);
  });

  it('does not re-announce a row that left and came back', () => {
    const { arrivals } = replay([
      [bucket('customers-waiting', ['o1'])],
      [bucket('customers-waiting', [])],
      [bucket('customers-waiting', ['o1'])],
    ]);
    expect(arrivals).toEqual([[], [], []]);
  });

  it('stays quiet when a failed read recovers, and still catches what really arrived', () => {
    const { arrivals } = replay([
      [bucket('proofs', ['p1', 'p2'])],
      [bucket('proofs', [], { ok: false, total: 0 })],
      [bucket('proofs', ['p1', 'p2', 'p3'])],
    ]);
    expect(arrivals).toEqual([[], [], ['proofs:p3']]);
  });

  it('baselines a bucket it has never read — a role change or a first failed read', () => {
    const { arrivals } = replay([
      [bucket('proofs', [], { ok: false })],
      [bucket('proofs', ['p1', 'p2'])],
      [bucket('proofs', ['p1', 'p2', 'p3']), bucket('withdrawals', ['w1'])],
    ]);
    expect(arrivals).toEqual([[], [], ['proofs:p3']]);
  });

  it('does not take the next row of a capped bucket moving up for a new one', () => {
    // 60 slips, the oldest 50 read. Approving the oldest brings the 51st into the read.
    const first50 = Array.from({ length: 50 }, (_, i) => `p${i}`);
    const next50 = [...first50.slice(1), 'p50'];
    const { arrivals } = replay([
      [bucket('proofs', first50, { total: 60 })],
      [bucket('proofs', next50, { total: 59 })],
    ]);
    expect(arrivals[1]).toEqual([]);
  });

  it('lets a capped bucket announce no more rows than its total rose by', () => {
    const { arrivals } = replay([
      [bucket('proofs', ['p1', 'p2'], { total: 60 })],
      [bucket('proofs', ['p3', 'p4'], { total: 61 })],
    ]);
    expect(arrivals[1]).toEqual(['proofs:p3']);
  });

  it('never announces anything for a count-only bucket', () => {
    const { arrivals } = replay([
      [bucket('stalled', [], { total: 3 })],
      [bucket('stalled', [], { total: 9 })],
    ]);
    expect(arrivals).toEqual([[], []]);
  });

  it('trims the oldest memory first and never forgets what is on screen', () => {
    const { memory } = replay([
      [bucket('a', ['1', '2', '3'])],
      [bucket('a', ['4', '5'])],
    ]);
    const trimmed = detectArrivals(memory, [bucket('a', ['4', '5'])], 3);
    expect(trimmed.memory.keys).toEqual(['a:3', 'a:4', 'a:5']);
    // Still on screen after the trim, so still not news.
    expect(detectArrivals(trimmed.memory, [bucket('a', ['4', '5'])], 3).arrived).toEqual([]);
  });

  it('holds everything on screen even when that is more than the cap', () => {
    // A backlog bigger than the memory: with a hard cap, the first row fell out on every
    // refresh and was announced again, every minute.
    const onScreen = [bucket('a', ['1', '2', '3', '4'])];
    let memory = detectArrivals(null, onScreen, 3).memory;
    expect(memory.keys).toEqual(['a:1', 'a:2', 'a:3', 'a:4']);
    for (let i = 0; i < 3; i++) {
      const next = detectArrivals(memory, onScreen, 3);
      expect(next.arrived).toEqual([]);
      memory = next.memory;
    }
    // Once the backlog clears, the old keys are the ones that go.
    const after = detectArrivals(memory, [bucket('a', ['5'])], 3);
    expect(after.arrived).toEqual(['a:5']);
    expect(after.memory.keys).toEqual(['a:3', 'a:4', 'a:5']);
  });
});

describe('seen memory in storage', () => {
  it('round-trips', () => {
    const memory: SeenMemory = {
      keys: ['proofs:p1'],
      buckets: ['proofs'],
      totals: { proofs: 1 },
      fresh: ['proofs:p1'],
    };
    expect(parseSeen(serializeSeen(memory))).toEqual(memory);
  });

  it('reads anything else as no memory, which only costs a quiet baseline', () => {
    expect(parseSeen(null)).toBeNull();
    expect(parseSeen('')).toBeNull();
    expect(parseSeen('{not json')).toBeNull();
    expect(parseSeen('{"v":2,"keys":[],"buckets":[]}')).toBeNull();
    expect(parseSeen('{"v":1,"keys":[1],"buckets":[]}')).toBeNull();
  });

  it('tolerates a missing or damaged optional part', () => {
    expect(parseSeen('{"v":1,"keys":["a:1"],"buckets":["a"],"totals":{"a":"x"}}')).toEqual({
      keys: ['a:1'],
      buckets: ['a'],
      totals: {},
      fresh: [],
    });
  });

  it('announces what arrived since the last visit in this tab, not what was already there', () => {
    // Left the dashboard with o1 on screen; came back to o1 and o2.
    const stored = serializeSeen(detectArrivals(null, [bucket('scheduled-deliveries', ['o1'])]).memory);
    const back = detectArrivals(parseSeen(stored), [bucket('scheduled-deliveries', ['o1', 'o2'])]);
    expect(back.arrived).toEqual(['scheduled-deliveries:o2']);
  });
});

describe('flags', () => {
  it('starts the clock at once on a visible page, and only when it is seen on a hidden one', () => {
    const shown = addFresh({}, ['a:1'], NOW, true);
    expect(shown).toEqual({ 'a:1': NOW });
    const hidden = addFresh({}, ['a:1'], NOW, false);
    expect(hidden).toEqual({ 'a:1': null });
    // An hour hidden does not fade it.
    expect(expireFresh(hidden, NOW + 60 * 60_000)).toBe(hidden);
    const seen = startFreshClocks(hidden, NOW + 60 * 60_000);
    expect(seen).toEqual({ 'a:1': NOW + 60 * 60_000 });
  });

  it('keeps the first time a flag was raised when the same row is flagged again', () => {
    const f = addFresh({}, ['a:1'], NOW, true);
    expect(addFresh(f, ['a:1'], NOW + 5_000, true)).toBe(f);
  });

  it('fades after a few visible minutes', () => {
    const f = addFresh({}, ['a:1'], NOW, true);
    expect(expireFresh(f, NOW + FRESH_VISIBLE_MS - 1)).toBe(f);
    expect(expireFresh(f, NOW + FRESH_VISIBLE_MS)).toEqual({});
  });

  it('drops a flag when its row is opened', () => {
    const f = addFresh({}, ['a:1', 'a:2'], NOW, true);
    expect(dropFresh(f, ['a:1'])).toEqual({ 'a:2': NOW });
    expect(dropFresh(f, ['zz:9'])).toBe(f);
  });

  it('drops a flag whose row has gone, but not one whose bucket could not be read', () => {
    const f = addFresh({}, ['a:1', 'a:2', 'b:1'], NOW, true);
    const next = pruneFresh(f, [bucket('a', ['2']), bucket('b', [], { ok: false })]);
    expect(Object.keys(next)).toEqual(['a:2', 'b:1']);
  });

  it('counts flags per bucket, including rows past the ones listed', () => {
    expect(freshPerBucket(addFresh({}, ['a:1', 'a:2', 'b:1'], NOW, true))).toEqual({ a: 2, b: 1 });
  });

  it('splits a scoped key at the first colon only', () => {
    expect(scopedKey('proofs', 'x:y')).toBe('proofs:x:y');
    expect(bucketOfKey('proofs:x:y')).toBe('proofs');
  });
});

describe('titleWithCount', () => {
  it('prefixes the count and replaces rather than stacks it', () => {
    expect(titleWithCount('Favornoms Merchant', 3)).toBe('(3) Favornoms Merchant');
    expect(titleWithCount('(3) Favornoms Merchant', 4)).toBe('(4) Favornoms Merchant');
    expect(titleWithCount('(4) Favornoms Merchant', 0)).toBe('Favornoms Merchant');
    expect(titleWithCount('Favornoms Merchant', 0)).toBe('Favornoms Merchant');
  });
});
