import { describe, expect, it } from 'vitest';
import { cssUrl } from './css-url';

describe('cssUrl', () => {
  it('quotes the URL so spaces and brackets stay inside it', () => {
    expect(cssUrl('https://cdn.example.com/menu/photo (1).png')).toBe(
      'url("https://cdn.example.com/menu/photo (1).png")',
    );
  });

  it('escapes what would end the quoted value', () => {
    expect(cssUrl('https://x.test/a"b\\c\nd.png')).toBe('url("https://x.test/a%22b%5Cc%0Ad.png")');
  });
});
