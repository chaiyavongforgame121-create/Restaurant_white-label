import { beforeEach, describe, expect, it } from 'vitest';
import { useCart } from './cart';

const baseItem = {
  id: 'item-1',
  branchId: 'branch-1',
  categoryId: 'cat-1',
  name: 'Pad Krapow',
  price: 75,
  imageUrl: '/icon.svg',
  description: '',
  isRecommended: false,
  isNew: false,
  dietaryTags: [],
  rating: 0,
  reviewCount: 0,
  prepTimeMinutes: 0,
  calories: 0,
  isActive: true,
} as never;

describe('cart store', () => {
  beforeEach(() => {
    useCart.getState().clear();
    // Reset branchId so each test starts fresh
    useCart.setState({ branchId: null, notes: '', channel: 'delivery' });
  });

  it('starts empty with zero subtotal and zero items', () => {
    const s = useCart.getState();
    expect(s.lines).toEqual([]);
    expect(s.subtotal()).toBe(0);
    expect(s.itemCount()).toBe(0);
  });

  it('adds an item and tracks branchId', () => {
    useCart.getState().add(baseItem);
    const s = useCart.getState();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]?.quantity).toBe(1);
    expect(s.subtotal()).toBe(75);
    expect(s.itemCount()).toBe(1);
    expect(s.branchId).toBe('branch-1');
  });

  it('merges quantities for the same item with the same notes', () => {
    useCart.getState().add(baseItem);
    useCart.getState().add(baseItem, 2);
    const s = useCart.getState();
    expect(s.lines).toHaveLength(1);
    expect(s.lines[0]?.quantity).toBe(3);
    expect(s.subtotal()).toBe(225);
  });

  it('keeps lines separate when notes differ', () => {
    useCart.getState().add(baseItem, 1, 'no spice');
    useCart.getState().add(baseItem, 1, 'extra spicy');
    const s = useCart.getState();
    expect(s.lines).toHaveLength(2);
    expect(s.subtotal()).toBe(150);
  });

  it('treats empty/whitespace notes as no-notes (merges)', () => {
    useCart.getState().add(baseItem);
    useCart.getState().add(baseItem, 2, '   ');
    expect(useCart.getState().lines).toHaveLength(1);
    expect(useCart.getState().lines[0]?.quantity).toBe(3);
  });

  it('setQuantity removes the line when quantity drops to 0', () => {
    useCart.getState().add(baseItem);
    const lineId = useCart.getState().lines[0]!.id;
    useCart.getState().setQuantity(lineId, 0);
    expect(useCart.getState().lines).toHaveLength(0);
  });

  it('setQuantity updates positive values', () => {
    useCart.getState().add(baseItem);
    const lineId = useCart.getState().lines[0]!.id;
    useCart.getState().setQuantity(lineId, 5);
    expect(useCart.getState().lines[0]?.quantity).toBe(5);
    expect(useCart.getState().subtotal()).toBe(375);
  });

  it('remove drops the line', () => {
    useCart.getState().add(baseItem);
    const lineId = useCart.getState().lines[0]!.id;
    useCart.getState().remove(lineId);
    expect(useCart.getState().lines).toHaveLength(0);
  });

  it('setLineNotes updates notes and trims them', () => {
    useCart.getState().add(baseItem);
    const lineId = useCart.getState().lines[0]!.id;
    useCart.getState().setLineNotes(lineId, '  extra rice  ');
    expect(useCart.getState().lines[0]?.notes).toBe('extra rice');
  });

  it('setLineNotes treats empty string as undefined', () => {
    useCart.getState().add(baseItem, 1, 'note');
    const lineId = useCart.getState().lines[0]!.id;
    useCart.getState().setLineNotes(lineId, '   ');
    expect(useCart.getState().lines[0]?.notes).toBeUndefined();
  });

  it('clear drops all lines and notes', () => {
    useCart.getState().add(baseItem);
    useCart.getState().setNotes('please knock');
    useCart.getState().clear();
    const s = useCart.getState();
    expect(s.lines).toHaveLength(0);
    expect(s.notes).toBe('');
  });

  it('setChannel updates the order channel', () => {
    useCart.getState().setChannel('pickup');
    expect(useCart.getState().channel).toBe('pickup');
    useCart.getState().setChannel('dine_in');
    expect(useCart.getState().channel).toBe('dine_in');
  });
});
