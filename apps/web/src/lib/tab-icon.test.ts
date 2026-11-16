import { afterEach, describe, expect, it } from 'vitest';
import { refreshTabIcon } from '@favornoms/ui';

function addIcon(attrs: Record<string, string>): HTMLLinkElement {
  const link = document.createElement('link');
  for (const [k, v] of Object.entries(attrs)) link.setAttribute(k, v);
  document.head.appendChild(link);
  return link;
}

afterEach(() => {
  document.head.innerHTML = '';
});

describe('refreshTabIcon', () => {
  it('adds a copy of the 32x32 icon, leaving the page’s own links as they are', () => {
    const big = addIcon({ rel: 'icon', href: '/r/a/b/app-icon/192?v=1', sizes: '192x192', type: 'image/png' });
    const small = addIcon({ rel: 'icon', href: '/r/a/b/app-icon/favicon-32?v=1', sizes: '32x32', type: 'image/png' });
    expect(refreshTabIcon(document)).toBe('/r/a/b/app-icon/favicon-32?v=1');
    const links = Array.from(document.head.querySelectorAll('link[rel~="icon"]'));
    expect(links).toHaveLength(3);
    expect(links[0]).toBe(big);
    expect(links[1]).toBe(small);
    const added = links[2]!;
    expect(added.getAttribute('href')).toBe('/r/a/b/app-icon/favicon-32?v=1');
    expect(added.getAttribute('sizes')).toBe('32x32');
    expect(added.getAttribute('type')).toBe('image/png');
    expect(added.hasAttribute('data-tab-icon-refresh')).toBe(true);
  });

  it('replaces its own previous copy rather than piling them up', () => {
    addIcon({ rel: 'icon', href: '/favicon-32.png', sizes: '32x32' });
    refreshTabIcon(document);
    refreshTabIcon(document);
    refreshTabIcon(document);
    expect(document.head.querySelectorAll('link[data-tab-icon-refresh]')).toHaveLength(1);
    expect(document.head.querySelectorAll('link[rel~="icon"]')).toHaveLength(2);
  });

  it('falls back to the first icon when none is 32x32, and does nothing without one', () => {
    addIcon({ rel: 'apple-touch-icon', href: '/apple.png' });
    expect(refreshTabIcon(document)).toBeNull();
    expect(document.head.querySelectorAll('link[data-tab-icon-refresh]')).toHaveLength(0);
    addIcon({ rel: 'shortcut icon', href: '/legacy.ico' });
    expect(refreshTabIcon(document)).toBe('/legacy.ico');
  });

  it('marks the copy with the page, so each navigation names a different list', () => {
    addIcon({ rel: 'icon', href: '/r/a/b/app-icon/favicon-32?v=1', sizes: '32x32' });
    expect(refreshTabIcon(document, '/r/a/b/cart')).toBe('/r/a/b/app-icon/favicon-32?v=1#%2Fr%2Fa%2Fb%2Fcart');
    expect(refreshTabIcon(document, '/r/a/b')).toBe('/r/a/b/app-icon/favicon-32?v=1#%2Fr%2Fa%2Fb');
    // An href that already has a fragment is copied as it is.
    document.head.innerHTML = '';
    addIcon({ rel: 'icon', href: '/x.png#keep', sizes: '32x32' });
    expect(refreshTabIcon(document, '/p')).toBe('/x.png#keep');
  });

  it('follows the page when its icons change between navigations', () => {
    const first = addIcon({ rel: 'icon', href: '/one-32', sizes: '32x32' });
    refreshTabIcon(document);
    first.remove();
    addIcon({ rel: 'icon', href: '/two-32', sizes: '32x32' });
    expect(refreshTabIcon(document)).toBe('/two-32');
    expect(document.head.querySelector('link[data-tab-icon-refresh]')!.getAttribute('href')).toBe('/two-32');
  });
});
