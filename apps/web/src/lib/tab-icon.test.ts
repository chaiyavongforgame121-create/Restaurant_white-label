import { afterEach, describe, expect, it } from 'vitest';
import { keepTabIcon, refreshTabIcon } from '@favornoms/ui';

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

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const refreshCopy = () => document.head.querySelector('link[data-tab-icon-refresh]')?.getAttribute('href') ?? null;

describe('keepTabIcon', () => {
  it('adds the copy once started', async () => {
    addIcon({ rel: 'icon', href: '/a-32', sizes: '32x32' });
    const keeper = keepTabIcon(document);
    await tick();
    expect(refreshCopy()).toMatch(/^\/a-32#/);
    keeper.stop();
  });

  it('adds it again when the page icons arrive after the navigation, however late', async () => {
    const own = addIcon({ rel: 'icon', href: '/a-32', sizes: '32x32' });
    const keeper = keepTabIcon(document);
    await tick();
    // A navigation: the framework takes its links out, the tick runs with none (no copy)...
    own.remove();
    keeper.refresh();
    await tick();
    expect(refreshCopy()).toBeNull();
    // ...and the new page's metadata lands later.
    addIcon({ rel: 'icon', href: '/b-32', sizes: '32x32' });
    await tick();
    expect(refreshCopy()).toMatch(/^\/b-32#/);
    keeper.stop();
  });

  it('ignores its own copy, so it never feeds itself', async () => {
    addIcon({ rel: 'icon', href: '/a-32', sizes: '32x32' });
    const keeper = keepTabIcon(document);
    await tick();
    const first = document.head.querySelector('link[data-tab-icon-refresh]');
    await tick();
    await tick();
    expect(document.head.querySelector('link[data-tab-icon-refresh]')).toBe(first);
    keeper.stop();
  });

  it('stops watching once stopped', async () => {
    const keeper = keepTabIcon(document);
    await tick();
    keeper.stop();
    addIcon({ rel: 'icon', href: '/late-32', sizes: '32x32' });
    await tick();
    expect(refreshCopy()).toBeNull();
  });
});
