'use client';

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { refreshTabIcon } from '@favornoms/ui';

/**
 * Tells the browser the tab icon again after each in-app navigation (refreshTabIcon explains why:
 * Chrome on Android dropped the branch's icon from the tab as soon as the app moved to another
 * page). After the new route has rendered and its URL is committed, hence the timeout.
 */
export function TabIconRefresh() {
  const pathname = usePathname();
  React.useEffect(() => {
    const id = window.setTimeout(() => refreshTabIcon(document, pathname), 0);
    return () => window.clearTimeout(id);
  }, [pathname]);
  return null;
}
