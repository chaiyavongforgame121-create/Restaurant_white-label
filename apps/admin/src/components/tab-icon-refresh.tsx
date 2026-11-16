'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { keepTabIcon, type TabIconKeeper } from '@favornoms/ui';

/**
 * Tells the browser the tab icon again after each in-app navigation (refreshTabIcon explains why:
 * Chrome on Android dropped the branch's icon from the tab as soon as the app moved to another
 * page). After the new route has rendered and its URL is committed (keepTabIcon waits a tick),
 * and again whenever the page's own icon links change, since metadata can arrive after the URL.
 */
export function TabIconRefresh() {
  const pathname = usePathname();
  const keeper = React.useRef<TabIconKeeper | null>(null);
  // Watches the head for the page's own icon links changing, however late a page's metadata lands.
  React.useEffect(() => {
    const k = keepTabIcon(document);
    keeper.current = k;
    return () => {
      k.stop();
      keeper.current = null;
    };
  }, []);
  // And after every navigation, for a page whose icon links did not change at all.
  React.useEffect(() => {
    keeper.current?.refresh();
  }, [pathname]);
  return null;
}
