import { describe, expect, it } from 'vitest';
import { safeNext } from './safe-next';

const ORIGIN = 'https://shop.example.com';

describe('safeNext', () => {
  it('passes through a plain same-origin path', () => {
    expect(safeNext('/checkout', ORIGIN)).toBe('/checkout');
  });

  it('keeps search and hash', () => {
    expect(safeNext('/r/a/b/checkout?x=1#y', ORIGIN)).toBe('/r/a/b/checkout?x=1#y');
  });

  it('rejects missing input', () => {
    expect(safeNext(null, ORIGIN)).toBeNull();
    expect(safeNext(undefined, ORIGIN)).toBeNull();
    expect(safeNext('', ORIGIN)).toBeNull();
  });

  // The WHATWG parser treats a backslash as a path separator for http/https, so every one
  // of these resolves to https://evil.com/ despite starting with a single slash.
  it.each(['/\\evil.com', '/\\/evil.com', '/\\\\evil.com', '/./\\evil.com'])(
    'rejects backslash-smuggled host %j',
    (input) => {
      expect(safeNext(input, ORIGIN)).toBeNull();
    },
  );

  // The parser strips leading ASCII control characters before parsing, so a control char
  // cannot be relied on to keep "//evil.com" out of the protocol-relative branch.
  it.each(['/\t//evil.com', '/\r//evil.com', '/\n//evil.com'])(
    'rejects control-char-smuggled host %j',
    (input) => {
      expect(safeNext(input, ORIGIN)).toBeNull();
    },
  );

  it.each(['//evil.com', '////evil.com'])('rejects protocol-relative %j', (input) => {
    expect(safeNext(input, ORIGIN)).toBeNull();
  });

  // `..` normalizes back into a protocol-relative path even though dest.origin looks local.
  it('rejects traversal that renormalizes into a protocol-relative path', () => {
    expect(safeNext('/..//evil.com', ORIGIN)).toBeNull();
  });

  it.each(['https://evil.com', 'javascript:alert(1)'])('rejects absolute URL %j', (input) => {
    expect(safeNext(input, ORIGIN)).toBeNull();
  });

  // SSR has no window; callers pass '' and must get null rather than a throw.
  it('returns null for an empty origin instead of throwing', () => {
    expect(safeNext('/checkout', '')).toBeNull();
  });
});
