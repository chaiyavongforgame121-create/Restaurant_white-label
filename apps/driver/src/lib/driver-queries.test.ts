// The rider app's reads in packages/database/src/queries/driver.ts, against a stand-in Supabase
// client that records every filter. Lives here because the driver app is where they run (and the
// database package has no test runner of its own).
import { describe, expect, it } from 'vitest';
import { getActiveDelivery, holdsOpenDelivery } from '@favornoms/database/queries';

type Filter = [method: string, ...args: unknown[]];
interface Call {
  table: string;
  head: boolean;
  filters: Filter[];
}
type Answer = { data?: unknown; count?: number | null; error?: { message: string } | null };

/** Each query is answered by the first responder that recognises it. */
function fakeClient(respond: (call: Call) => Answer) {
  const calls: Call[] = [];
  const builder = (table: string) => {
    const call: Call = { table, head: false, filters: [] };
    calls.push(call);
    const settle = () => {
      const a = respond(call);
      return Promise.resolve({ data: a.data ?? null, count: a.count ?? null, error: a.error ?? null });
    };
    const chain: Record<string, unknown> = {};
    for (const method of ['eq', 'neq', 'is', 'lte', 'gt', 'in', 'or', 'order', 'limit']) {
      chain[method] = (...args: unknown[]) => {
        call.filters.push([method, ...args]);
        return chain;
      };
    }
    chain.select = (_columns: string, options?: { head?: boolean }) => {
      call.head = !!options?.head;
      return chain;
    };
    chain.maybeSingle = settle;
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => settle().then(resolve, reject);
    return chain;
  };
  const client = {
    from: builder,
    rpc: async (fn: string) => {
      if (fn === 'get_driver_order') return { data: { id: 'o1', order_number: 'A-1' }, error: null };
      return { data: null, error: null };
    },
  };
  return { client: client as never, calls };
}

const has = (call: Call, ...filter: Filter) => call.filters.some((f) => JSON.stringify(f) === JSON.stringify(filter));
const isLapsedCheck = (call: Call) => call.head && has(call, 'lte', 'offer_expires_at', 'now');
const isAssignmentRead = (call: Call) => call.table === 'delivery_assignments';

const OFFER = {
  id: 'd1',
  batch_id: null,
  status: 'assigned',
  accepted_at: null,
  offer_expires_at: '2026-10-05T15:31:15.123456+00:00',
};

describe('getActiveDelivery: an offer the server’s clock has ended', () => {
  it('asks the database’s own clock, for that offer only', async () => {
    const { client, calls } = fakeClient((call) =>
      isLapsedCheck(call) ? { count: 0 } : isAssignmentRead(call) ? { data: null } : { data: OFFER },
    );
    await getActiveDelivery(client, 'r1');
    const check = calls.find(isLapsedCheck)!;
    expect(check.table).toBe('deliveries');
    expect(has(check, 'eq', 'id', 'd1')).toBe(true);
    expect(has(check, 'eq', 'driver_id', 'r1')).toBe(true);
    expect(has(check, 'eq', 'status', 'assigned')).toBe(true);
    expect(has(check, 'is', 'accepted_at', null)).toBe(true);
  });

  it('comes back empty for it, so the phone neither rings nor shows Accept', async () => {
    const { client } = fakeClient((call) => (isLapsedCheck(call) ? { count: 1 } : { data: OFFER }));
    expect(await getActiveDelivery(client, 'r1')).toBeNull();
  });

  it('returns a live offer', async () => {
    const { client } = fakeClient((call) =>
      isLapsedCheck(call) ? { count: 0 } : isAssignmentRead(call) ? { data: null } : { data: OFFER },
    );
    expect(await getActiveDelivery(client, 'r1')).toMatchObject({ id: 'd1', order: { id: 'o1' } });
  });

  it('returns the offer when the clock check itself fails: unknown is not over', async () => {
    const { client } = fakeClient((call) =>
      isLapsedCheck(call)
        ? { error: { message: 'boom' } }
        : isAssignmentRead(call)
          ? { data: null }
          : { data: OFFER },
    );
    expect(await getActiveDelivery(client, 'r1')).toMatchObject({ id: 'd1' });
  });

  it('never asks for an accepted job, or an old offer without a deadline', async () => {
    for (const row of [
      { ...OFFER, accepted_at: '2026-10-05T15:30:10Z' },
      { ...OFFER, status: 'picked_up', accepted_at: '2026-10-05T15:30:10Z' },
      { ...OFFER, offer_expires_at: null },
    ]) {
      const { client, calls } = fakeClient((call) => (isAssignmentRead(call) ? { data: null } : { data: row }));
      expect(await getActiveDelivery(client, 'r1')).toMatchObject({ id: 'd1' });
      expect(calls.some(isLapsedCheck)).toBe(false);
    }
  });
});

describe('holdsOpenDelivery: is anything still this rider’s?', () => {
  const answer = (held: Answer, lapsed: Answer) =>
    fakeClient((call) => (isLapsedCheck(call) ? lapsed : held)).client;

  it('no when the server has nothing', async () => {
    expect(await holdsOpenDelivery(answer({ count: 0 }, { count: 0 }), 'r1')).toBe(false);
  });

  it('no when all it has is an offer its clock has ended (the sweep has not released it yet)', async () => {
    expect(await holdsOpenDelivery(answer({ count: 1 }, { count: 1 }), 'r1')).toBe(false);
  });

  it('yes for a job or a live offer', async () => {
    expect(await holdsOpenDelivery(answer({ count: 1 }, { count: 0 }), 'r1')).toBe(true);
  });

  it('yes when the clock check fails, as before it existed; unknown when the read fails', async () => {
    expect(await holdsOpenDelivery(answer({ count: 1 }, { error: { message: 'boom' } }), 'r1')).toBe(true);
    expect(await holdsOpenDelivery(answer({ error: { message: 'boom' } }, { count: 0 }), 'r1')).toBeNull();
  });
});
