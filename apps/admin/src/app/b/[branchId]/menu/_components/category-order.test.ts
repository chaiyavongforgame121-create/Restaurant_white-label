import { describe, expect, it } from 'vitest';
import {
  categoryIds,
  categoryOrderPayload,
  moveCategory,
  nextDisplayOrder,
  reconcileOrder,
  sameOrder,
} from './category-order';

const cat = (id: string, displayOrder = 0, name = id) => ({ id, displayOrder, name });

describe('moveCategory', () => {
  it('drops a category where the row it was dropped on sits', () => {
    const list = [cat('a'), cat('b'), cat('c'), cat('d')];
    expect(categoryIds(moveCategory(list, 'd', 'b'))).toEqual(['a', 'd', 'b', 'c']);
    expect(categoryIds(moveCategory(list, 'a', 'c'))).toEqual(['b', 'c', 'a', 'd']);
  });

  it('returns the same array when nothing moved, so a no-op drop writes nothing', () => {
    const list = [cat('a'), cat('b')];
    expect(moveCategory(list, 'a', 'a')).toBe(list);
    // The row was deleted in another tab while the drag was in the air.
    expect(moveCategory(list, 'a', 'gone')).toBe(list);
    expect(moveCategory(list, 'gone', 'a')).toBe(list);
  });

  it('leaves the list it was given alone', () => {
    const list = [cat('a'), cat('b'), cat('c')];
    moveCategory(list, 'c', 'a');
    expect(categoryIds(list)).toEqual(['a', 'b', 'c']);
  });
});

describe('categoryOrderPayload', () => {
  it('renumbers the whole branch from 0 in one payload', () => {
    expect(categoryOrderPayload([cat('a', 4), cat('b', 1), cat('c', 9)])).toEqual([
      { id: 'a', display_order: 0 },
      { id: 'b', display_order: 1 },
      { id: 'c', display_order: 2 },
    ]);
  });

  it('is empty for a branch with no categories', () => {
    expect(categoryOrderPayload([])).toEqual([]);
  });
});

describe('sameOrder', () => {
  it('is true only for the same ids in the same places', () => {
    expect(sameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameOrder(['a', 'b'], ['a'])).toBe(false);
    expect(sameOrder([], [])).toBe(true);
  });
});

describe('reconcileOrder', () => {
  it('keeps the arrangement on screen when a reload brings the same categories back', () => {
    const local = [cat('c'), cat('a'), cat('b')];
    const incoming = [cat('a'), cat('b'), cat('c')];
    expect(categoryIds(reconcileOrder(local, incoming))).toEqual(['c', 'a', 'b']);
  });

  it('takes the reloaded row, so a rename shows through without losing its place', () => {
    const local = [cat('b', 0, 'Drinks'), cat('a', 0, 'Starters')];
    const incoming = [cat('a', 0, 'Starters'), cat('b', 0, 'Cold drinks')];
    expect(reconcileOrder(local, incoming).map((c) => c.name)).toEqual(['Cold drinks', 'Starters']);
  });

  it('drops a deleted category and puts a new one last', () => {
    const local = [cat('c'), cat('a'), cat('b')];
    // 'b' was deleted, 'd' was added.
    const incoming = [cat('a'), cat('c'), cat('d')];
    expect(categoryIds(reconcileOrder(local, incoming))).toEqual(['c', 'a', 'd']);
  });

  it('is the reloaded list when nothing was dragged', () => {
    const incoming = [cat('a'), cat('b')];
    expect(categoryIds(reconcileOrder(incoming, incoming))).toEqual(['a', 'b']);
  });
});

describe('nextDisplayOrder', () => {
  it('clears a branch that has never been renumbered', () => {
    expect(nextDisplayOrder([cat('a', 1), cat('b', 2), cat('c', 7)])).toBe(8);
  });

  it('clears a branch a drag has renumbered from 0', () => {
    expect(nextDisplayOrder([cat('a', 0), cat('b', 1), cat('c', 2)])).toBe(3);
  });

  it('clears the positions on screen even when every stored order is 0', () => {
    expect(nextDisplayOrder([cat('a', 0), cat('b', 0), cat('c', 0)])).toBe(3);
  });

  it('starts at 0 for an empty branch', () => {
    expect(nextDisplayOrder([])).toBe(0);
  });
});
