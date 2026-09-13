'use client';

// The pending package-request count, read once by platform/layout.tsx.
//
// PlatformNav is rendered by six different client pages, so threading a prop
// through each of them would mean every future page has to remember it. A
// merchant whose trial lapsed sits dark until someone opens the Requests tab, and
// nothing on the console said a request was waiting — this is that signal.

import * as React from 'react';

const PendingRequestsCtx = React.createContext(0);

export function PendingRequestsProvider({
  count,
  children,
}: {
  count: number;
  children: React.ReactNode;
}) {
  return <PendingRequestsCtx.Provider value={count}>{children}</PendingRequestsCtx.Provider>;
}

/** 0 outside the provider, so a badge simply does not render. */
export function usePendingRequestCount(): number {
  return React.useContext(PendingRequestsCtx);
}
