import { describe, expect, it } from 'vitest';
import {
  customerDisplayIdentity,
  customerSearchFilter,
  isPlaceholderCustomerName,
  isSyntheticEmail,
} from '@favornoms/database/queries';
import { customerSortQuery, parseCustomerSort } from '@favornoms/shared';

describe('isPlaceholderCustomerName', () => {
  it.each(['Walk-in', 'walk in', 'WALKIN', 'Guest', 'Table 4', 'table A1', '  ', '', 'Deleted user'])(
    'treats %j as nobody',
    (name) => {
      expect(isPlaceholderCustomerName(name)).toBe(true);
    },
  );

  it.each(['Bobby', 'Bird', 'Tablet Tom', 'Guesthouse Anna'])('keeps %j', (name) => {
    expect(isPlaceholderCustomerName(name)).toBe(false);
  });
});

describe('isSyntheticEmail', () => {
  it('spots the sign-in addresses nobody chose', () => {
    expect(isSyntheticEmail('c16266386400@customer.favornoms.local')).toBe(true);
    expect(isSyntheticEmail('d10123456789@driver.favornoms.local')).toBe(true);
    expect(isSyntheticEmail('demo-owner@favornoms.local')).toBe(true);
    expect(isSyntheticEmail('driver@test.com')).toBe(false);
    expect(isSyntheticEmail(null)).toBe(false);
  });
});

describe('customerDisplayIdentity', () => {
  const orders = [
    { customer_name: 'Walk-in', customer_phone: '+10000000000', created_at: '2026-09-18T10:00:00Z' },
    { customer_name: 'Bird', customer_phone: '+66815929554', created_at: '2026-09-17T10:00:00Z' },
    { customer_name: 'Old Name', customer_phone: '+66000000000', created_at: '2026-09-01T10:00:00Z' },
  ];

  it('prefers the profile', () => {
    const id = customerDisplayIdentity({ full_name: 'Bobby', phone: '6266386401', email: null }, orders);
    expect(id).toMatchObject({ name: 'Bobby', nameSource: 'profile', phone: '6266386401', phoneFromOrder: false });
  });

  it('falls back to the latest real order name and number, skipping till placeholders', () => {
    const id = customerDisplayIdentity({ full_name: '  ', phone: null, email: null }, orders);
    expect(id).toMatchObject({ name: 'Bird', nameSource: 'order', phone: '+66815929554', phoneFromOrder: true });
  });

  it('falls back to a real email, never a synthetic one', () => {
    expect(
      customerDisplayIdentity({ full_name: null, phone: null, email: 'driver@test.com' }, []),
    ).toMatchObject({ name: 'driver@test.com', nameSource: 'email', email: 'driver@test.com' });
    expect(
      customerDisplayIdentity({ full_name: null, phone: null, email: 'c1@customer.favornoms.local' }, []),
    ).toMatchObject({ name: null, nameSource: null, email: null });
  });
});

/** Whether any phone clause of the filter would match `phone` (ILIKE '%x%' is a substring test). */
const phoneMatches = (filter: string | null, phone: string): boolean =>
  [...(filter ?? '').matchAll(/phone\.ilike\."%([^"]*)%"/g)].some((m) =>
    phone.toLowerCase().includes((m[1] ?? '').toLowerCase()),
  );

describe('customerSearchFilter', () => {
  it('searches name, email and phone, and the phone by its digits', () => {
    expect(customerSearchFilter('081 592')).toBe(
      'full_name.ilike."%081 592%",email.ilike."%081 592%",phone.ilike."%081 592%",phone.ilike."%081592%",phone.ilike."%81592%"',
    );
  });

  it('finds an E.164 phone from the local way of writing it, trunk 0 and all', () => {
    const stored = '+66815929554';
    expect(phoneMatches(customerSearchFilter('081 592'), stored)).toBe(true);
    expect(phoneMatches(customerSearchFilter('0815929554'), stored)).toBe(true);
    expect(phoneMatches(customerSearchFilter('+66 81 592'), stored)).toBe(true);
    expect(phoneMatches(customerSearchFilter('592 9554'), stored)).toBe(true);
    expect(phoneMatches(customerSearchFilter('0899'), stored)).toBe(false);
  });

  it('never widens a short number into a two-digit match', () => {
    expect(customerSearchFilter('081')).toBe(
      'full_name.ilike."%081%",email.ilike."%081%",phone.ilike."%081%"',
    );
  });

  it('drops the characters that are syntax inside the filter', () => {
    expect(customerSearchFilter('bo,b(%)"')).toBe(
      'full_name.ilike."%bo b%",email.ilike."%bo b%",phone.ilike."%bo b%"',
    );
    expect(customerSearchFilter(' ,() ')).toBeNull();
  });
});

describe('search in the list URL', () => {
  it('rides along with sorting and paging', () => {
    const qs = customerSortQuery({ sort: 'name', dir: 'asc', page: 2, q: '  bob  ' });
    const sp = new URLSearchParams(qs);
    expect(sp.get('q')).toBe('bob');
    expect(
      parseCustomerSort({
        sort: sp.get('sort') ?? undefined,
        dir: sp.get('dir') ?? undefined,
        page: sp.get('page') ?? undefined,
        q: sp.get('q') ?? undefined,
      }),
    ).toEqual({ sort: 'name', dir: 'asc', page: 2, q: 'bob' });
  });

  it('leaves an unfiltered list without q', () => {
    expect(parseCustomerSort({ q: '   ' })).toEqual({ sort: 'spent', dir: 'desc', page: 1 });
  });
});
