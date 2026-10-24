// The kitchen station queries (docs/KITCHEN-STATIONS-2026-10-24.md): what each one sends and how it
// reads the answer. A hand-rolled client stands in for supabase-js; the SQL itself is pinned by
// supabase/tests/kitchen_stations.sql.
import { describe, expect, it } from 'vitest';
import type { FavornomsClient } from '../client-type';
import {
  createKitchenStation,
  deleteKitchenStation,
  listKitchenStations,
  renameKitchenStation,
  reorderKitchenStations,
} from './kitchen-stations';

const BRANCH = '11111111-1111-4111-8111-111111111111';
const STATION = '22222222-2222-4222-8222-222222222222';

type Answer = { data: unknown; error: { message: string; code?: string } | null };
type Call = { table: string; steps: Array<[string, ...unknown[]]> };

/**
 * Records every query builder chain, step by step, and answers each chain in turn from `answers`
 * (rpc calls are answered by function name from `rpcAnswers`).
 */
function fakeClient(answers: Answer[], rpcAnswers: Record<string, Answer> = {}) {
  const calls: Call[] = [];
  const rpcs: Array<{ fn: string; args: Record<string, unknown> }> = [];
  let next = 0;
  const client = {
    from(table: string) {
      const call: Call = { table, steps: [] };
      calls.push(call);
      const answer = answers[next++] ?? { data: null, error: { message: 'unexpected query on ' + table } };
      const builder: Record<string, unknown> = {};
      for (const step of ['select', 'eq', 'order', 'limit', 'insert', 'update']) {
        builder[step] = (...args: unknown[]) => {
          call.steps.push([step, ...args]);
          return builder;
        };
      }
      for (const end of ['single', 'maybeSingle']) {
        builder[end] = async () => {
          call.steps.push([end]);
          return answer;
        };
      }
      // A chain awaited without single()/maybeSingle() resolves to the whole answer.
      builder.then = (resolve: (value: Answer) => unknown) => resolve(answer);
      return builder;
    },
    async rpc(fn: string, args: Record<string, unknown>) {
      rpcs.push({ fn, args });
      return rpcAnswers[fn] ?? { data: null, error: { message: 'unexpected rpc ' + fn } };
    },
  };
  return { client: client as unknown as FavornomsClient, calls, rpcs };
}

const ROW = { id: STATION, branch_id: BRANCH, key: 'st_0123456789', name: 'Grill', display_order: 60 };
const STATION_OUT = { id: STATION, branchId: BRANCH, key: 'st_0123456789', name: 'Grill', displayOrder: 60 };

describe('listKitchenStations', () => {
  it("reads the branch's stations in display_order, then key, then id", async () => {
    const { client, calls } = fakeClient([
      { data: [{ id: 'a', branch_id: BRANCH, key: 'hot', name: null, display_order: 10 }, ROW], error: null },
    ]);
    const stations = await listKitchenStations(client, BRANCH);
    expect(stations).toEqual([
      { id: 'a', branchId: BRANCH, key: 'hot', name: null, displayOrder: 10 },
      STATION_OUT,
    ]);
    expect(calls[0]!.table).toBe('kitchen_stations');
    expect(calls[0]!.steps).toEqual([
      ['select', 'id, branch_id, key, name, display_order'],
      ['eq', 'branch_id', BRANCH],
      ['order', 'display_order', { ascending: true }],
      ['order', 'key', { ascending: true }],
      ['order', 'id', { ascending: true }],
    ]);
  });

  it('throws what the read failed with', async () => {
    const { client } = fakeClient([{ data: null, error: { message: 'permission denied for table kitchen_stations' } }]);
    await expect(listKitchenStations(client, BRANCH)).rejects.toMatchObject({
      message: 'permission denied for table kitchen_stations',
    });
  });
});

describe('createKitchenStation', () => {
  it('adds the trimmed name ten after the last station, never sending a key', async () => {
    const { client, calls } = fakeClient([
      { data: { display_order: 50 }, error: null },
      { data: ROW, error: null },
    ]);
    expect(await createKitchenStation(client, BRANCH, '  Grill ')).toEqual(STATION_OUT);
    expect(calls[0]!.steps).toEqual([
      ['select', 'display_order'],
      ['eq', 'branch_id', BRANCH],
      ['order', 'display_order', { ascending: false }],
      ['limit', 1],
      ['maybeSingle'],
    ]);
    expect(calls[1]!.steps[0]).toEqual(['insert', { branch_id: BRANCH, name: 'Grill', display_order: 60 }]);
    expect(calls[1]!.steps.at(-1)).toEqual(['single']);
  });

  it('starts at 10 on a branch with no station left', async () => {
    const { client, calls } = fakeClient([
      { data: null, error: null },
      { data: { ...ROW, display_order: 10 }, error: null },
    ]);
    await createKitchenStation(client, BRANCH, 'Grill');
    expect(calls[1]!.steps[0]).toEqual(['insert', { branch_id: BRANCH, name: 'Grill', display_order: 10 }]);
  });

  it("passes the database's refusal on", async () => {
    const { client } = fakeClient([
      { data: { display_order: 50 }, error: null },
      { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } },
    ]);
    await expect(createKitchenStation(client, BRANCH, 'grill')).rejects.toMatchObject({ code: '23505' });
  });
});

describe('renameKitchenStation', () => {
  it('writes only the trimmed name', async () => {
    const { client, calls } = fakeClient([{ data: { ...ROW, name: 'Charcoal' }, error: null }]);
    expect(await renameKitchenStation(client, STATION, ' Charcoal ')).toEqual({ ...STATION_OUT, name: 'Charcoal' });
    expect(calls[0]!.steps).toEqual([
      ['update', { name: 'Charcoal' }],
      ['eq', 'id', STATION],
      ['select', 'id, branch_id, key, name, display_order'],
      ['maybeSingle'],
    ]);
  });

  it('sends null for null or a blank name (a built-in back to its translation)', async () => {
    for (const name of [null, '   ']) {
      const { client, calls } = fakeClient([{ data: { ...ROW, key: 'hot', name: null }, error: null }]);
      expect((await renameKitchenStation(client, STATION, name)).name).toBeNull();
      expect(calls[0]!.steps[0]).toEqual(['update', { name: null }]);
    }
  });

  it('throws station_not_found when no row changed', async () => {
    const { client } = fakeClient([{ data: null, error: null }]);
    await expect(renameKitchenStation(client, STATION, 'Grill')).rejects.toMatchObject({
      message: 'station_not_found',
      code: 'P0002',
    });
  });
});

describe('deleteKitchenStation', () => {
  it('moves the dishes to the station given and answers how many moved', async () => {
    const { client, rpcs } = fakeClient([], { delete_kitchen_station: { data: 3, error: null } });
    expect(await deleteKitchenStation(client, STATION, 'hot')).toBe(3);
    expect(rpcs).toEqual([{ fn: 'delete_kitchen_station', args: { p_station_id: STATION, p_move_to: 'hot' } }]);
  });

  it('leaves p_move_to and p_clear out when neither is asked for', async () => {
    const { client, rpcs } = fakeClient([], { delete_kitchen_station: { data: 0, error: null } });
    expect(await deleteKitchenStation(client, STATION, null)).toBe(0);
    expect(rpcs[0]!.args).toEqual({ p_station_id: STATION });
  });

  it('sends p_clear only when the dishes are to go to "no station" on purpose', async () => {
    for (const [options, args] of [
      [{ clear: true }, { p_station_id: STATION, p_clear: true }],
      [{ clear: false }, { p_station_id: STATION }],
      [{}, { p_station_id: STATION }],
    ] as const) {
      const { client, rpcs } = fakeClient([], { delete_kitchen_station: { data: 2, error: null } });
      expect(await deleteKitchenStation(client, STATION, null, options)).toBe(2);
      expect(rpcs[0]!.args).toEqual(args);
    }
  });

  it('passes p_clear with a target too, where the database ignores it', async () => {
    const { client, rpcs } = fakeClient([], { delete_kitchen_station: { data: 1, error: null } });
    await deleteKitchenStation(client, STATION, 'hot', { clear: true });
    expect(rpcs[0]!.args).toEqual({ p_station_id: STATION, p_move_to: 'hot', p_clear: true });
  });

  it('throws the refusal', async () => {
    const { client } = fakeClient([], {
      delete_kitchen_station: { data: null, error: { code: 'P0001', message: 'move_target_invalid' } },
    });
    await expect(deleteKitchenStation(client, STATION, 'nope')).rejects.toMatchObject({ message: 'move_target_invalid' });
  });

  it('throws station_in_use for a station given dishes since the list was read', async () => {
    const { client } = fakeClient([], {
      delete_kitchen_station: { data: null, error: { code: 'P0001', message: 'station_in_use' } },
    });
    await expect(deleteKitchenStation(client, STATION, null)).rejects.toMatchObject({
      code: 'P0001',
      message: 'station_in_use',
    });
  });
});

describe('reorderKitchenStations', () => {
  it('sends the branch and every id in order', async () => {
    const { client, rpcs } = fakeClient([], { reorder_kitchen_stations: { data: null, error: null } });
    await reorderKitchenStations(client, BRANCH, ['b', 'a']);
    expect(rpcs).toEqual([{ fn: 'reorder_kitchen_stations', args: { p_branch_id: BRANCH, p_ids: ['b', 'a'] } }]);
  });

  it('throws ids_mismatch', async () => {
    const { client } = fakeClient([], {
      reorder_kitchen_stations: { data: null, error: { code: 'P0001', message: 'ids_mismatch' } },
    });
    await expect(reorderKitchenStations(client, BRANCH, ['a'])).rejects.toMatchObject({ message: 'ids_mismatch' });
  });
});
