import { describe, expect, it } from 'vitest';
import { accountPhoneLabel } from './account-phone';

describe('accountPhoneLabel', () => {
  it('shows a North American number the way the owner asked for it', () => {
    expect(accountPhoneLabel('+15552345678', null)).toBe('+1 (555) 234-5678');
    // Settings saves what the diner typed, so the row can hold a national spelling too.
    expect(accountPhoneLabel('(555) 234-5678', null)).toBe('+1 (555) 234-5678');
  });

  it('groups any other country rather than passing it off as +1', () => {
    // The owner's screenshot: this used to sit under the name as one run of digits.
    expect(accountPhoneLabel('+66980358264', null)).toBe('+66 98 035 8264');
  });

  it('prefers the customers row over the auth column', () => {
    expect(accountPhoneLabel('+15552345678', '66980358264')).toBe('+1 (555) 234-5678');
  });

  it('puts the plus back on the auth column before formatting it', () => {
    // Supabase Auth stores bare digits; without the plus a Thai number would not be grouped.
    expect(accountPhoneLabel(null, '66980358264')).toBe('+66 98 035 8264');
    expect(accountPhoneLabel('  ', '15552345678')).toBe('+1 (555) 234-5678');
    expect(accountPhoneLabel(null, '+66980358264')).toBe('+66 98 035 8264');
  });

  it('shows nothing rather than an empty or placeholder number', () => {
    expect(accountPhoneLabel(null, null)).toBeNull();
    expect(accountPhoneLabel('', '')).toBeNull();
    expect(accountPhoneLabel(undefined, undefined)).toBeNull();
    // The till's walk-in placeholder carries no number; the card should reach for the email.
    expect(accountPhoneLabel('+10000000000', null)).toBeNull();
    // ...or for a real auth number, when there is one.
    expect(accountPhoneLabel('+10000000000', '66980358264')).toBe('+66 98 035 8264');
  });
});
