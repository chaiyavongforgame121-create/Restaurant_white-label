import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  changeDraftGroup,
  changedFields,
  copyErrorKey,
  draftProblem,
  draftSteps,
  groupFromRow,
  groupKind,
  groupsFromLinks,
  GroupWrites,
  isGroupGone,
  isSourceRefusal,
  keepKeys,
  libraryChoices,
  parseGroupCopy,
  parseResetAnswer,
  showCopy,
  type GroupCopy,
  type GroupRow,
  type MGroup,
  type MOption,
  type WriteTarget,
} from './item-modifier-model';

const DISH = 'dish-1';

const option = (id: string, over: Partial<MOption> = {}): MOption => ({
  id,
  key: id,
  name: id.toUpperCase(),
  price_delta: 0,
  is_default: false,
  is_active: true,
  display_order: 0,
  ...over,
});

const group = (id: string, over: Partial<MGroup> = {}): MGroup => ({
  id,
  key: id,
  name: 'Spicy Level',
  selection_type: 'single',
  is_required: false,
  min_select: 0,
  max_select: 1,
  display_order: 0,
  options: [],
  own: false,
  sourceGroupId: null,
  ...over,
});

const row = (id: string, over: Partial<GroupRow> = {}): GroupRow => ({
  id,
  name: 'Spicy Level',
  selection_type: 'single',
  is_required: false,
  min_select: 0,
  max_select: 1,
  display_order: 0,
  created_at: '2026-10-01T00:00:00Z',
  owner_menu_item_id: null,
  source_group_id: null,
  modifier_options: [],
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Lets every promise callback queued so far run. */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const copyOf = (groupId: string, options: Record<string, string>, over: Partial<GroupCopy> = {}): GroupCopy => ({
  groupId,
  copied: true,
  sourceGroupId: 'lib',
  options: new Map(Object.entries(options)),
  ...over,
});

describe('groupKind', () => {
  it('tells a library group, the dish’s copy and a group made for the dish apart', () => {
    expect(groupKind({ own: false, sourceGroupId: null })).toBe('library');
    expect(groupKind({ own: true, sourceGroupId: 'lib' })).toBe('copy');
    expect(groupKind({ own: true, sourceGroupId: null })).toBe('dishOnly');
  });
});

describe('changedFields', () => {
  it('keeps only what changes, so a click that changes nothing writes nothing', () => {
    const optional = group('lib', { selection_type: 'single', is_required: false, min_select: 0, max_select: 1 });
    // "Pick 1" on a group that already is one, and "−" at the minimum.
    expect(changedFields(optional, { selection_type: 'single', max_select: 1, min_select: 0 })).toEqual({});
    expect(changedFields(optional, { max_select: 1 })).toEqual({});
    // A required group stored with no minimum: "Pick 1" would write one (hence the switch ignores it).
    const required = group('lib', { is_required: true, min_select: 0 });
    expect(changedFields(required, { selection_type: 'single', max_select: 1, min_select: 1 })).toEqual({ min_select: 1 });
    expect(changedFields(optional, { selection_type: 'multiple', max_select: 2 })).toEqual({
      selection_type: 'multiple',
      max_select: 2,
    });
    expect(changedFields(optional, { name: 'Spicy Level ' })).toEqual({ name: 'Spicy Level ' });
  });
});

describe('reading a dish’s groups', () => {
  it('counts a group as the dish’s own only when this dish owns it', () => {
    expect(groupFromRow(row('g'), 0, DISH)).toMatchObject({ own: false, sourceGroupId: null });
    expect(groupFromRow(row('g', { owner_menu_item_id: DISH, source_group_id: 'lib' }), 0, DISH)).toMatchObject({
      own: true,
      sourceGroupId: 'lib',
    });
    // Never linkable in practice (tg_menu_item_modifiers_same_branch); treated as not this dish's.
    expect(groupFromRow(row('g', { owner_menu_item_id: 'other', source_group_id: 'lib' }), 0, DISH)).toMatchObject({
      own: false,
      sourceGroupId: null,
    });
    // A dish not saved yet owns nothing.
    expect(groupFromRow(row('g', { owner_menu_item_id: DISH }), 0, null).own).toBe(false);
  });

  it('keys rows by their id, sorts options the storefront’s way and normalises the rules', () => {
    const g = groupFromRow(
      row('g', {
        selection_type: 'multiple',
        max_select: null,
        min_select: null,
        is_required: null,
        modifier_options: [
          { id: 'b', name: 'Hot', price_delta: '1.50', is_default: null, is_active: true, display_order: 1, created_at: 'x' },
          { id: 'a', name: 'Mild', price_delta: 0, is_default: true, is_active: false, display_order: 0, created_at: 'x' },
        ],
      }),
      3,
      DISH,
    );
    expect(g).toMatchObject({ key: 'g', display_order: 3, selection_type: 'multiple', min_select: 0, max_select: 1 });
    expect(g.options.map((o) => [o.id, o.key, o.is_default, o.is_active, o.price_delta])).toEqual([
      ['a', 'a', true, false, 0],
      ['b', 'b', false, true, '1.50'],
    ]);
  });

  it('lists links by their position on the dish, then the group’s own position', () => {
    const groups = groupsFromLinks(
      [
        { display_order: 1, modifier_groups: row('second') },
        { display_order: 0, modifier_groups: [row('first')] },
        { display_order: 1, modifier_groups: row('tie', { display_order: -1 }) },
        { display_order: 2, modifier_groups: null },
      ],
      DISH,
    );
    expect(groups.map((g) => [g.id, g.display_order])).toEqual([
      ['first', 0],
      ['tie', 1],
      ['second', 1],
    ]);
  });
});

describe('keepKeys', () => {
  it('keeps the keys of rows already on screen, a copy’s included, and keys new rows by id', () => {
    const onScreen = [
      group('copy', { key: 'lib', own: true, options: [option('c1', { key: 'l1' }), option('c2', { key: 'l2' })] }),
      group('other'),
    ];
    const read = [
      group('copy', { own: true, options: [option('c2'), option('c1'), option('c3')] }),
      group('new'),
    ];
    const keyed = keepKeys(read, onScreen);
    expect(keyed.map((g) => g.key)).toEqual(['lib', 'new']);
    expect(keyed[0]!.options.map((o) => o.key)).toEqual(['l2', 'l1', 'c3']);
  });

  it('never gives two rows the same key', () => {
    // The copy keeps key "lib"; the dish also shows the library group "lib" itself.
    const onScreen = [group('copy', { key: 'lib', own: true })];
    const keyed = keepKeys([group('lib'), group('copy', { own: true })], onScreen);
    const keys = keyed.map((g) => g.key);
    expect(new Set(keys).size).toBe(2);
    expect(keys[1]).toBe('lib');
  });

  it('returns the same row objects when nothing changes key', () => {
    const read = [group('a'), group('b')];
    const keyed = keepKeys(read, [group('a'), group('b')]);
    expect(keyed[1]).toBe(read[1]);
  });
});

describe('parseGroupCopy', () => {
  it('reads both answers of customize_item_modifier_group', () => {
    expect(
      parseGroupCopy({ group_id: 'copy', copied: true, source_group_id: 'lib', options: { l1: 'c1', l2: 'c2' } }),
    ).toEqual({ groupId: 'copy', copied: true, sourceGroupId: 'lib', options: new Map([['l1', 'c1'], ['l2', 'c2']]) });
    expect(parseGroupCopy({ group_id: 'own', copied: false, source_group_id: null, options: {} })).toEqual({
      groupId: 'own',
      copied: false,
      sourceGroupId: null,
      options: new Map(),
    });
  });

  it('refuses anything else', () => {
    for (const bad of [null, 'copy', [], {}, { group_id: '' }, { group_id: 'c', options: [] }, { group_id: 'c', options: { l1: 3 } }]) {
      expect(parseGroupCopy(bad)).toBeNull();
    }
  });
});

describe('parseResetAnswer', () => {
  it('reads the library group reset_item_modifier_group put back, and refuses anything else', () => {
    expect(parseResetAnswer({ group_id: 'lib' })).toBe('lib');
    for (const bad of [null, 'lib', [], {}, { group_id: '' }, { group_id: 3 }]) {
      expect(parseResetAnswer(bad)).toBeNull();
    }
  });
});

describe('showCopy', () => {
  it('swaps in the copy’s ids, keeping keys and what was typed meanwhile', () => {
    const typed = group('lib', {
      name: 'Spicy Levelx',
      options: [option('l1', { name: 'Hott' }), option('l2'), option('gone')],
    });
    const other = group('other');
    const [shown, untouched] = showCopy([typed, other], 'lib', copyOf('copy', { l1: 'c1', l2: 'c2' }));
    expect(shown).toMatchObject({ id: 'copy', key: 'lib', name: 'Spicy Levelx', own: true, sourceGroupId: 'lib' });
    expect(shown!.options.map((o) => [o.id, o.key, o.name])).toEqual([
      ['c1', 'l1', 'Hott'],
      ['c2', 'l2', 'L2'],
      ['gone', 'gone', 'GONE'],
    ]);
    expect(untouched).toBe(other);
  });

  it('only marks a group that already was the dish’s own', () => {
    const own = group('own', { own: false, options: [option('o1')] });
    const [shown] = showCopy([own], 'own', copyOf('own', { o1: 'o1' }, { copied: false, sourceGroupId: null }));
    expect(shown).toMatchObject({ id: 'own', own: true, sourceGroupId: null });
    expect(shown!.options[0]).toBe(own.options[0]);
  });
});

describe('GroupWrites', () => {
  const setup = (copy: (groupId: string) => Promise<GroupCopy>) => {
    const events: string[] = [];
    const writes = new GroupWrites({
      copy: (groupId) => {
        events.push(`copy ${groupId}`);
        return copy(groupId);
      },
      onCopied: (fromId, made) => events.push(`copied ${fromId}->${made.groupId}`),
      onCopyFailed: (fromId) => events.push(`failed ${fromId}`),
    });
    const task = (label: string, extra?: (to: WriteTarget) => string) => (to: WriteTarget) => {
      events.push(`${label} ${to.groupId}${extra ? ` ${extra(to)}` : ''}`);
      return Promise.resolve({ error: null });
    };
    return { writes, events, task };
  };

  it('copies a library group once for every write waiting on it, then writes to the copy in order', async () => {
    const answer = deferred<GroupCopy>();
    const { writes, events, task } = setup(() => answer.promise);
    const library = { id: 'lib', own: false };
    const results = [
      writes.run(library, task('name', (to) => to.optionId('l1')), { copy: true }),
      writes.run(library, task('price', (to) => to.optionId('l2')), { copy: true }),
      writes.run(library, task('default', (to) => to.optionId('unknown')), { copy: true }),
    ];
    await flush();
    expect(events).toEqual(['copy lib']);
    answer.resolve(copyOf('copy', { l1: 'c1', l2: 'c2' }));
    expect(await Promise.all(results)).toEqual([{ error: null }, { error: null }, { error: null }]);
    expect(events).toEqual(['copy lib', 'copied lib->copy', 'name copy c1', 'price copy c2', 'default copy unknown']);
    expect(writes.groupId('lib')).toBe('copy');
    expect(writes.groupId('copy')).toBe('copy');
    expect(writes.optionId('l2')).toBe('c2');
    expect(writes.optionId('c2')).toBe('c2');
  });

  it('keeps a write made with the copy’s id behind the ones made before it', async () => {
    const { writes, events } = setup(() => Promise.resolve(copyOf('copy', { l1: 'c1' })));
    const slow = deferred<{ error: unknown }>();
    const first = writes.run({ id: 'lib', own: false }, (to) => {
      events.push(`slow ${to.groupId}`);
      return slow.promise;
    }, { copy: true });
    await flush();
    // The screen shows the copy now, so the next write names the copy.
    const second = writes.run({ id: 'copy', own: true }, (to) => {
      events.push(`fast ${to.groupId}`);
      return Promise.resolve({ error: null });
    }, { copy: true });
    await flush();
    expect(events).toEqual(['copy lib', 'copied lib->copy', 'slow copy']);
    slow.resolve({ error: null });
    await Promise.all([first, second]);
    expect(events).toEqual(['copy lib', 'copied lib->copy', 'slow copy', 'fast copy']);
  });

  it('drops the writes waiting for a failed copy, says so once, and copies again on the next change', async () => {
    let calls = 0;
    const { writes, events, task } = setup(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(copyOf('copy', {}));
    });
    const library = { id: 'lib', own: false };
    const dropped = await Promise.all([
      writes.run(library, task('a'), { copy: true }),
      writes.run(library, task('b'), { copy: true }),
    ]);
    expect(dropped).toEqual([null, null]);
    expect(events).toEqual(['copy lib', 'failed lib']);
    expect(writes.groupId('lib')).toBe('lib');
    expect(await writes.run(library, task('c'), { copy: true })).toEqual({ error: null });
    expect(events).toEqual(['copy lib', 'failed lib', 'copy lib', 'copied lib->copy', 'c copy']);
  });

  it('still runs a task that does not copy, queued behind a failed copy', async () => {
    const { writes, events, task } = setup(() => Promise.reject(new Error('offline')));
    const library = { id: 'lib', own: false };
    const [change, remove] = await Promise.all([
      writes.run(library, task('change'), { copy: true }),
      writes.run(library, task('remove', (to) => String(to.own)), { copy: false }),
    ]);
    expect(change).toBeNull();
    expect(remove).toEqual({ error: null });
    expect(events).toEqual(['copy lib', 'failed lib', 'remove lib false']);
  });

  it('never copies a group that is already the dish’s own', async () => {
    const copy = vi.fn(() => Promise.resolve(copyOf('x', {})));
    const writes = new GroupWrites({ copy, onCopied: vi.fn(), onCopyFailed: vi.fn() });
    const seen: WriteTarget[] = [];
    await writes.run({ id: 'own', own: true }, (to) => {
      seen.push(to);
      return Promise.resolve({ error: null });
    }, { copy: true });
    expect(copy).not.toHaveBeenCalled();
    expect(seen[0]).toMatchObject({ groupId: 'own', own: true });
    expect(seen[0]!.optionId('o1')).toBe('o1');
  });

  it('gives a task that does not copy the group as the dish shows it now', async () => {
    const { writes, events, task } = setup(() => Promise.resolve(copyOf('copy', {})));
    const library = { id: 'lib', own: false };
    await writes.run(library, task('remove', (to) => String(to.own)), { copy: false });
    await writes.run(library, task('change'), { copy: true });
    // A Remove clicked on the library card while its copy was being made: the copy goes.
    await writes.run(library, task('remove', (to) => String(to.own)), { copy: false });
    expect(events).toEqual(['remove lib false', 'copy lib', 'copied lib->copy', 'change copy', 'remove copy true']);
  });

  it('copies again after the dish went back to the library group', async () => {
    let n = 0;
    const { writes, events, task } = setup(() => Promise.resolve(copyOf(`copy${++n}`, { l1: `c${n}` })));
    const library = { id: 'lib', own: false };
    await writes.run(library, task('change'), { copy: true });
    await writes.run({ id: 'copy1', own: true }, (to) => {
      writes.forget(to.groupId, 'lib');
      events.push(`reset ${to.groupId}`);
      return Promise.resolve({ error: null });
    }, { copy: false });
    expect(writes.groupId('lib')).toBe('lib');
    // A move clicked while the copy showed names the library group the dish shows now.
    expect(writes.groupId('copy1')).toBe('lib');
    expect(writes.optionId('l1')).toBe('l1');
    await writes.run(library, task('change'), { copy: true });
    expect(events).toEqual([
      'copy lib',
      'copied lib->copy1',
      'change copy1',
      'reset copy1',
      'copy lib',
      'copied lib->copy2',
      'change copy2',
    ]);
    expect(writes.groupId('copy1')).toBe('copy2');
  });

  it('names a copy made on an earlier visit by its library group once the dish went back to it', () => {
    const writes = new GroupWrites({ copy: vi.fn(), onCopied: vi.fn(), onCopyFailed: vi.fn() });
    expect(writes.groupId('old-copy')).toBe('old-copy');
    writes.forget('old-copy', 'lib');
    expect(writes.groupId('old-copy')).toBe('lib');
    expect(writes.groupId('lib')).toBe('lib');
  });

  it('runs an exclusive task after what was queued before it and holds what is queued meanwhile', async () => {
    const answer = deferred<GroupCopy>();
    const events: string[] = [];
    const writes = new GroupWrites({
      copy: (groupId) => {
        events.push(`copy ${groupId}`);
        return groupId === 'lib' ? answer.promise : Promise.resolve(copyOf(`${groupId}-copy`, {}, { sourceGroupId: groupId }));
      },
      onCopied: (fromId, made) => events.push(`copied ${fromId}->${made.groupId}`),
      onCopyFailed: vi.fn(),
    });
    const write = (label: string) => (to: WriteTarget) => {
      events.push(`${label} ${to.groupId}`);
      return Promise.resolve({ error: null });
    };
    const rename = writes.run({ id: 'lib', own: false }, write('rename'), { copy: true });
    const stored = deferred<{ error: unknown }>();
    // The group order: its ids are read once the rename (and the copy it waits for) has landed.
    const order = writes.exclusive(() => {
      events.push(`order ${writes.groupId('lib')},${writes.groupId('size')}`);
      return stored.promise;
    });
    // Size's first change, made while the order is out: its copy would move Size's link meanwhile.
    const size = writes.run({ id: 'size', own: false }, write('size'), { copy: true });
    await flush();
    expect(events).toEqual(['copy lib']);
    answer.resolve(copyOf('lib-copy', {}));
    await rename;
    await flush();
    expect(events).toEqual(['copy lib', 'copied lib->lib-copy', 'rename lib-copy', 'order lib-copy,size']);
    stored.resolve({ error: null });
    expect(await order).toEqual({ error: null });
    expect(await size).toEqual({ error: null });
    expect(events.slice(4)).toEqual(['copy size', 'copied size->size-copy', 'size size-copy']);
  });

  it('runs exclusive tasks one at a time, and lets the queues go on after one fails', async () => {
    const { writes, events, task } = setup(() => Promise.resolve(copyOf('copy', {})));
    const first = deferred<string>();
    const a = writes.exclusive(() => {
      events.push('a');
      return first.promise;
    });
    const b = writes.exclusive(() => {
      events.push('b');
      return Promise.reject(new Error('offline'));
    });
    const bRefused = expect(b).rejects.toThrow('offline');
    await flush();
    expect(events).toEqual(['a']);
    first.resolve('stored');
    expect(await a).toBe('stored');
    await bRefused;
    expect(await writes.run({ id: 'own', own: true }, task('after'), { copy: true })).toEqual({ error: null });
    expect(events).toEqual(['a', 'b', 'after own']);
  });

  it('turns a thrown task into its error and keeps the queue going', async () => {
    const { writes, task } = setup(() => Promise.resolve(copyOf('copy', {})));
    const boom = new Error('boom');
    const own = { id: 'own', own: true };
    const failed = writes.run(own, () => Promise.reject(boom), { copy: true });
    const next = writes.run(own, task('next'), { copy: true });
    expect(await failed).toEqual({ error: boom });
    expect(await next).toEqual({ error: null });
  });

  it('does not hold one group’s writes behind another group’s copy', async () => {
    const answer = deferred<GroupCopy>();
    const { writes, events, task } = setup(() => answer.promise);
    const slow = writes.run({ id: 'lib', own: false }, task('a'), { copy: true });
    await writes.run({ id: 'own', own: true }, task('b'), { copy: true });
    expect(events).toEqual(['copy lib', 'b own']);
    let idle = false;
    void writes.idle().then(() => {
      idle = true;
    });
    await flush();
    expect(idle).toBe(false);
    answer.resolve(copyOf('copy', {}));
    await slow;
    await flush();
    expect(idle).toBe(true);
  });

  it('counts what is still queued, so a read can wait for it', async () => {
    const answer = deferred<GroupCopy>();
    const seen: string[] = [];
    const writes = new GroupWrites({
      copy: () => answer.promise,
      onCopied: vi.fn(),
      onCopyFailed: vi.fn(),
      onSettled: () => seen.push(`settled ${writes.pending}/${writes.settled}`),
    });
    const ok = () => Promise.resolve({ error: null });
    const first = writes.run({ id: 'lib', own: false }, ok, { copy: true });
    const second = writes.run({ id: 'lib', own: false }, ok, { copy: true });
    const other = writes.run({ id: 'own', own: true }, ok, { copy: true });
    expect([writes.pending, writes.settled]).toEqual([3, 0]);
    await other;
    // Counted before the caller hears back.
    expect([writes.pending, writes.settled]).toEqual([2, 1]);
    answer.resolve(copyOf('copy', {}));
    await Promise.all([first, second]);
    expect([writes.pending, writes.settled]).toEqual([0, 3]);
    expect(seen).toEqual(['settled 2/1', 'settled 1/2', 'settled 0/3']);
  });

  it('counts dropped writes as settled too', async () => {
    const onSettled = vi.fn();
    const writes = new GroupWrites({
      copy: () => Promise.reject(new Error('offline')),
      onCopied: vi.fn(),
      onCopyFailed: vi.fn(),
      onSettled,
    });
    const ok = () => Promise.resolve({ error: null });
    await Promise.all([
      writes.run({ id: 'lib', own: false }, ok, { copy: true }),
      writes.run({ id: 'lib', own: false }, ok, { copy: true }),
    ]);
    expect([writes.pending, writes.settled]).toEqual([0, 2]);
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('changes no ids when the group turned out to be the dish’s own already', async () => {
    const { writes, events, task } = setup(() =>
      Promise.resolve(copyOf('mine', { o1: 'o1' }, { copied: false, sourceGroupId: null })),
    );
    await writes.run({ id: 'mine', own: false }, task('change', (to) => to.optionId('o1')), { copy: true });
    await writes.run({ id: 'mine', own: false }, task('again'), { copy: true });
    expect(events).toEqual(['copy mine', 'copied mine->mine', 'change mine o1', 'again mine']);
    expect(writes.optionId('o1')).toBe('o1');
  });
});

describe('changeDraftGroup', () => {
  const mint = () => {
    let n = 0;
    return () => `tmp_${n++}`;
  };

  it('changes a group made for the dish in place', () => {
    const own = group('tmp_a', { own: true, options: [option('tmp_b')] });
    const [changed] = changeDraftGroup([own], 'tmp_a', mint(), (g, same) => ({
      ...g,
      options: g.options.map((o) => (same(o.id, 'tmp_b') ? { ...o, name: 'Large' } : o)),
    }));
    expect(changed).toMatchObject({ id: 'tmp_a', own: true, sourceGroupId: null });
    expect(changed!.options[0]).toMatchObject({ id: 'tmp_b', name: 'Large' });
  });

  it('turns a picked library group into the dish’s copy before changing it', () => {
    const picked = group('lib', { options: [option('l1'), option('l2', { name: 'Hot' })] });
    const other = group('other');
    const [copy, untouched] = changeDraftGroup([picked, other], 'lib', mint(), (g, same) => ({
      ...g,
      options: g.options.filter((o) => !same(o.id, 'l2')),
    }));
    expect(copy).toMatchObject({ key: 'lib', own: true, sourceGroupId: 'lib' });
    expect(copy!.id).toMatch(/^tmp_/);
    expect(copy!.options.map((o) => [o.key, o.name])).toEqual([['l1', 'L1']]);
    expect(copy!.options[0]!.id).toMatch(/^tmp_/);
    expect(untouched).toBe(other);
    // The picked library group itself is left as it was.
    expect(picked.options).toHaveLength(2);
  });
});

describe('draftProblem', () => {
  it('asks for a name, an option and named options in the dish’s own groups', () => {
    expect(draftProblem([group('a', { own: true, name: ' ', options: [option('x')] })])).toEqual({ key: 'groupName' });
    expect(draftProblem([group('a', { own: true, name: 'Size', options: [option('x', { name: ' ' })] })])).toEqual({
      key: 'noOptions',
      group: 'Size',
    });
    expect(draftProblem([group('a', { own: true, name: 'Size' })])).toEqual({ key: 'noOptions', group: 'Size' });
    expect(
      draftProblem([group('a', { own: true, name: ' Size ', options: [option('x'), option('y', { name: '' })] })]),
    ).toEqual({ key: 'blankOptions', group: 'Size' });
  });

  it('lets an empty group through (it is dropped) and leaves library groups to their page', () => {
    expect(draftProblem([group('a', { own: true, name: '' })])).toBeNull();
    expect(draftProblem([group('lib', { name: '', options: [option('x', { name: '' })] })])).toBeNull();
    expect(draftProblem([group('a', { own: true, name: 'Size', options: [option('x')] })])).toBeNull();
  });
});

describe('draftSteps', () => {
  it('links untouched library groups and writes the dish’s own groups with their source', () => {
    const steps = draftSteps([
      group('lib', { name: 'Spicy Level ', options: [option('l1')] }),
      group('tmp_0', { own: true, name: '', options: [] }),
      group('tmp_1', {
        own: true,
        sourceGroupId: 'lib2',
        name: ' Size ',
        selection_type: 'multiple',
        is_required: true,
        min_select: 1,
        max_select: 2,
        options: [
          option('tmp_2', { name: ' Large ', price_delta: '1.5', is_default: true }),
          option('tmp_3', { name: '  ' }),
          option('tmp_4', { name: 'Small', price_delta: 'abc', is_active: false }),
        ],
      }),
      group('tmp_5', { own: true, name: 'Notes', options: [] }),
    ]);
    expect(steps).toEqual([
      { kind: 'link', groupId: 'lib', name: 'Spicy Level', position: 0 },
      {
        kind: 'own',
        position: 1,
        sourceGroupId: 'lib2',
        group: { name: 'Size', selection_type: 'multiple', is_required: true, min_select: 1, max_select: 2 },
        options: [
          { name: 'Large', price_delta: 1.5, is_default: true, is_active: true, display_order: 0 },
          { name: 'Small', price_delta: 0, is_default: false, is_active: false, display_order: 1 },
        ],
      },
      {
        kind: 'own',
        position: 2,
        sourceGroupId: null,
        group: { name: 'Notes', selection_type: 'single', is_required: false, min_select: 0, max_select: 1 },
        options: [],
      },
    ]);
  });
});

describe('libraryChoices', () => {
  it('offers library groups the dish does not show yet, as they are or as its copy', () => {
    const library = [
      row('c', { display_order: 2 }),
      row('a', { display_order: 0 }),
      row('b', { display_order: 1 }),
      row('copied', { display_order: 3 }),
      row('mine', { owner_menu_item_id: DISH }),
    ];
    const onDish = [group('b'), group('copy', { own: true, sourceGroupId: 'copied' })];
    expect(libraryChoices(library, onDish).map((r) => r.id)).toEqual(['a', 'c']);
  });
});

describe('failures', () => {
  it('names the refusals of the copy and reset functions', () => {
    expect(copyErrorKey({ code: 'P0002', message: 'modifier_link_not_found' })).toBe('listChanged');
    expect(copyErrorKey({ code: 'P0002', message: 'modifier_group_not_customized' })).toBe('listChanged');
    expect(copyErrorKey({ code: '23514', message: 'modifier_group_owned_elsewhere' })).toBe('listChanged');
    expect(copyErrorKey({ code: 'P0002', message: 'modifier_source_missing' })).toBe('sourceMissing');
    expect(copyErrorKey({ code: 'P0002', message: 'item_not_found' })).toBeNull();
    expect(copyErrorKey(new TypeError('Failed to fetch'))).toBeNull();
    expect(copyErrorKey(null)).toBeNull();
  });

  it('recognises a copy saved with a source that is gone', () => {
    expect(isSourceRefusal({ code: '23514', message: 'modifier_source_invalid' })).toBe(true);
    expect(
      isSourceRefusal({
        code: '23503',
        message: 'insert or update on table "modifier_groups" violates foreign key constraint "modifier_groups_source_group_id_fkey"',
      }),
    ).toBe(true);
    expect(
      isSourceRefusal({
        code: '23503',
        message: 'insert or update on table "modifier_groups" violates foreign key constraint "modifier_groups_owner_menu_item_id_fkey"',
      }),
    ).toBe(false);
    expect(isSourceRefusal(null)).toBe(false);
  });

  it('recognises a link to a group that was deleted', () => {
    expect(
      isGroupGone({
        code: '23503',
        message:
          'insert or update on table "menu_item_modifiers" violates foreign key constraint "menu_item_modifiers_modifier_group_id_fkey"',
      }),
    ).toBe(true);
    expect(isGroupGone({ code: '23505', message: 'duplicate key value violates unique constraint' })).toBe(false);
    expect(isGroupGone(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('menu.modifiers messages', () => {
  const messages = (locale: string) =>
    JSON.parse(
      readFileSync(path.resolve(__dirname, `../../../../../../messages/${locale}/menu.json`), 'utf8'),
    ) as { modifiers: Record<string, unknown> };

  const leaves = (node: unknown, prefix = ''): Map<string, string> => {
    const out = new Map<string, string>();
    if (typeof node === 'string') out.set(prefix, node);
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        for (const [key, value] of leaves(v, prefix ? `${prefix}.${k}` : k)) out.set(key, value);
      }
    }
    return out;
  };

  /** The {placeholders} a message takes, plural branches' text left out. */
  const placeholders = (message: string) =>
    [...new Set([...message.matchAll(/\{(\w+)(?=[,}])/g)].map((m) => m[1]))].sort().join(' ');

  it('has the editor’s keys in every locale, with the same placeholders', () => {
    const en = leaves(messages('en').modifiers);
    for (const key of [
      'addFromLibrary',
      'library.title',
      'library.hint',
      'library.loading',
      'library.empty',
      'library.allAdded',
      'library.add',
      'library.addNamed',
      'library.unnamed',
      'library.optionCount',
      'library.pickUpTo',
      'library.close',
      'library.gone',
      'library.goneNamed',
      'source.library',
      'source.libraryHint',
      'source.customized',
      'source.useLibrary',
      'source.dishOnly',
      'resetConfirm.title',
      'resetConfirm.body',
      'resetConfirm.confirm',
      'removeConfirm.libraryTitle',
      'removeConfirm.libraryBody',
      'removeConfirm.ownTitle',
      'removeConfirm.ownBody',
      'removeConfirm.remove',
      'removeConfirm.delete',
      'copyFailed',
      'copyErrors.listChanged',
      'copyErrors.sourceMissing',
    ]) {
      expect(en.get(key), `en menu.modifiers.${key}`).toBeTypeOf('string');
    }
    for (const locale of ['es', 'th', 'vi']) {
      const other = leaves(messages(locale).modifiers);
      expect([...other.keys()].sort(), `${locale} menu.modifiers keys`).toEqual([...en.keys()].sort());
      for (const [key, value] of en) {
        expect(placeholders(other.get(key) ?? ''), `${locale} menu.modifiers.${key}`).toBe(placeholders(value));
      }
    }
  });
});
