'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';

/**
 * A server-rendered page cannot subscribe, and useRealtime here would mean moving all nine
 * dashboard reads into the browser. A minute's router.refresh() while the tab is visible is
 * enough for a screen whose only question is "what needs me now" — and unlike the kitchen
 * and delivery boards, this page holds no local work a refetch could erase, which is what
 * made auto-refresh unsafe there.
 */
export function AutoRefresh({ intervalMs = 60_000 }: { intervalMs?: number }) {
  const router = useRouter();
  React.useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const id = window.setInterval(tick, intervalMs);
    // A tab left open all afternoon is stale the instant it comes back, so waking it is
    // itself a reason to refetch rather than waiting out the rest of the interval.
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [router, intervalMs]);
  return null;
}
