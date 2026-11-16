// Keeps the browser tab's icon through in-app navigation (the owner's report of 2026-11-16: the
// storefront's icon showed on the menu and vanished, for the generic globe, once Chrome on an
// Android tablet moved on to "Your cart").
//
// Chrome keeps a favicon per page URL. A client-side navigation is a pushState to a new URL, and
// for that new URL Chrome waits to be told the page's icons again. The App Router re-renders the
// metadata on every navigation: it takes the <link rel="icon"> elements out and puts identical ones
// back, sometimes in the same task as the URL change and sometimes later, when the new page's
// metadata streams in after it (going back to the menu did that). Either way Chrome was left
// without an icon for the new URL. A full load of the same page was always fine.
//
// So this adds one <link rel="icon"> of its own (replacing the previous one), a copy of the page's
// preferred icon, after every navigation AND whenever the page's own icon links change, however
// late. Adding a link makes the browser read the page's icons again, now for the URL it is on. The
// copy's href carries the page as a #fragment, so the list differs from the previous page's even if
// a browser skips a list it has seen (the fragment is never sent; the file is the same, from
// cache). The elements the framework manages are never touched, so it can still remove its own.

const MARK = 'data-tab-icon-refresh';

function isPageIconLink(node: Node): boolean {
  if (node.nodeName !== 'LINK') return false;
  const link = node as Element;
  return !link.hasAttribute(MARK) && /(^|\s)icon(\s|$)/i.test(link.getAttribute('rel') ?? '');
}

/** Re-announces the page's tab icon for `page` (the path it is on). Returns the copy's href, or null
 *  when the page names no icon (then there is no copy either). */
export function refreshTabIcon(doc: Document, page = ''): string | null {
  doc.head.querySelectorAll(`link[${MARK}]`).forEach((el) => el.remove());
  const icons = Array.from(doc.head.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]'));
  // The 32x32 when there is one (what the tab shows), else the first icon the page names.
  const source = icons.find((l) => l.getAttribute('sizes') === '32x32') ?? icons[0];
  const href = source?.getAttribute('href');
  if (!source || !href) return null;
  const copy = page && !href.includes('#') ? `${href}#${encodeURIComponent(page)}` : href;
  const link = doc.createElement('link');
  link.setAttribute('rel', 'icon');
  link.setAttribute('href', copy);
  const sizes = source.getAttribute('sizes');
  if (sizes) link.setAttribute('sizes', sizes);
  const type = source.getAttribute('type');
  if (type) link.setAttribute('type', type);
  link.setAttribute(MARK, '');
  doc.head.appendChild(link);
  return copy;
}

export interface TabIconKeeper {
  /** Re-announce on the next tick (after a navigation). */
  refresh: () => void;
  stop: () => void;
}

/**
 * Re-announces the tab icon now, whenever the page's own icon links are added or removed (its own
 * copy is ignored, so this never feeds itself), and on refresh(). Each burst of changes is
 * collapsed into one re-announcement on the next tick, read for the URL the page is on by then.
 */
export function keepTabIcon(doc: Document): TabIconKeeper {
  const win = doc.defaultView;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refresh = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      refreshTabIcon(doc, win?.location.pathname ?? '');
    }, 0);
  };
  const Observer = win?.MutationObserver;
  const observer = Observer
    ? new Observer((records) => {
        for (const record of records) {
          for (const node of [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)]) {
            if (isPageIconLink(node)) {
              refresh();
              return;
            }
          }
        }
      })
    : null;
  observer?.observe(doc.head, { childList: true });
  refresh();
  return {
    refresh,
    stop: () => {
      observer?.disconnect();
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
