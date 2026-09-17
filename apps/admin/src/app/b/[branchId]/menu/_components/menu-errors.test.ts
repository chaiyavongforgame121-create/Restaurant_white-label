import { describe, expect, it } from 'vitest';
import { categoryDeleteErrorKey, menuErrorKey } from './menu-errors';

describe('menuErrorKey', () => {
  it('maps permission failures from codes, RPC raises and RLS text', () => {
    expect(menuErrorKey({ code: '42501', message: 'permission denied for table menu_items' })).toBe('permission');
    expect(menuErrorKey({ code: 'P0001', message: 'not_authorized' })).toBe('permission');
    expect(menuErrorKey({ message: 'new row violates row-level security policy' })).toBe('permission');
  });

  it('maps database constraint codes', () => {
    expect(menuErrorKey({ code: 'P0001', message: 'item_not_found' })).toBe('notFound');
    expect(menuErrorKey({ code: 'P0002', message: 'group_not_found' })).toBe('notFound');
    expect(menuErrorKey({ code: '23503', message: 'update or delete violates foreign key constraint' })).toBe('inUse');
    expect(menuErrorKey({ code: '23505', message: 'duplicate key value' })).toBe('duplicate');
    expect(menuErrorKey({ code: '22P02', message: 'invalid input syntax for type numeric' })).toBe('invalidValue');
    expect(menuErrorKey({ code: '23514', message: 'violates check constraint' })).toBe('invalidValue');
  });

  it('maps storage upload failures', () => {
    expect(menuErrorKey({ statusCode: '413', message: 'The object exceeded the maximum allowed size' })).toBe('fileTooLarge');
    expect(menuErrorKey({ message: 'mime type text/plain is not supported' })).toBe('fileType');
  });

  it('maps network failures, including thrown Errors', () => {
    expect(menuErrorKey(new TypeError('Failed to fetch'))).toBe('network');
    expect(menuErrorKey('TypeError: Load failed')).toBe('network');
  });

  it('falls back to generic for anything unknown', () => {
    expect(menuErrorKey(null)).toBe('generic');
    expect(menuErrorKey(undefined)).toBe('generic');
    expect(menuErrorKey({ code: 'XX000', message: 'internal error' })).toBe('generic');
    expect(menuErrorKey(new Error('something odd'))).toBe('generic');
  });
});

describe('categoryDeleteErrorKey', () => {
  it('maps the refusals delete_menu_category raises', () => {
    expect(categoryDeleteErrorKey({ code: 'P0001', message: 'category_not_empty' })).toBe('notEmpty');
    expect(categoryDeleteErrorKey({ code: 'P0001', message: 'invalid_move_target' })).toBe('invalidTarget');
    expect(
      categoryDeleteErrorKey({ code: 'P0001', message: 'category_used_by_happy_hour', details: 'Lunch deal' }),
    ).toBe('usedByHappyHour');
    expect(categoryDeleteErrorKey({ code: 'P0002', message: 'category_not_found' })).toBe('notFound');
  });

  it('leaves every other failure to menuErrorKey', () => {
    expect(categoryDeleteErrorKey({ code: '42501', message: 'not_authorized' })).toBeNull();
    expect(categoryDeleteErrorKey(new TypeError('Failed to fetch'))).toBeNull();
    expect(categoryDeleteErrorKey(null)).toBeNull();
  });
});
