import { describe, expect, it } from 'vitest';
import { resolveRecommendations } from './recommendations';

// The RPC row is deliberately thin (name, photo, raw price); everything the sheet and the
// cart need comes from the loaded menu, so these cases are all about what `items` says.
const item = (id: string, extra: Record<string, unknown> = {}) =>
  ({ id, branchId: 'b1', categoryId: 'c1', name: id, price: 10, imageUrl: null, ...extra }) as never;

describe('resolveRecommendations', () => {
  const items = [item('a'), item('b', { price: 8, listPrice: 10 }), item('c')];
  const row = (id: string) => ({ menu_item_id: id, item_name: id, image_url: null, price: 99 });

  it('pairs each row with the loaded MenuItem so the sheet gets effective price/stock/branch', () => {
    const out = resolveRecommendations([row('b')], items, 'a');
    expect(out).toHaveLength(1);
    expect(out[0]?.target.price).toBe(8);
    expect(out[0]?.target.branchId).toBe('b1');
  });

  it('drops rows that are not on the loaded menu', () => {
    expect(resolveRecommendations([row('zzz')], items, 'a')).toEqual([]);
  });

  it('drops the item currently open and duplicate rows', () => {
    const out = resolveRecommendations([row('a'), row('c'), row('c')], items, 'a');
    expect(out.map((x) => x.target.id)).toEqual(['c']);
  });

  it('keeps the order the RPC ranked them in', () => {
    const out = resolveRecommendations([row('c'), row('b')], items, 'a');
    expect(out.map((x) => x.target.id)).toEqual(['c', 'b']);
  });
});
