'use client';

import * as React from 'react';
import { createPortal } from 'react-dom';
import { ThemeVarsContext } from '../lib/theme-vars';

// Nothing to subscribe to: the answer changes once, from "server" to "browser", and React
// re-reads the snapshot on its own when hydration finishes.
const subscribeNever = () => () => {};
const onClient = () => true;
const onServer = () => false;

function stopClick(e: React.MouseEvent) {
  e.stopPropagation();
}

/**
 * Renders a full-screen overlay as the last thing in <body> instead of where it sits in
 * the tree.
 *
 * `position: fixed` and `z-index` are only as strong as the element's ancestors allow. A
 * sticky table cell, a positioned box with a z-index, anything faded below full opacity, a
 * framer-motion parent mid-move or a backdrop blur starts a new stacking context (the last
 * two also become the box a fixed child is positioned in), and an overlay inside one only
 * outranks its own siblings. That is how the admin Orders table painted the next row's
 * sticky "Receipt" button over an open receipt drawer: the drawer's z-[100] counted only
 * inside its own z-10 cell. On the body the overlay's z-index is measured against the
 * whole page again.
 *
 * Three things the move would otherwise cost, put back here:
 * - Nothing renders on the server or during hydration. The server has no body to portal
 *   into, and the first client render must match its HTML. An overlay mounted later (the
 *   usual case: somebody clicked) appears on its first render with no extra pass.
 * - The tenant's colours. ThemeProvider sets them as CSS variables on a wrapper this
 *   overlay has just left, so they are re-applied on this one.
 * - Clicks stop here. React bubbles events through a portal to the component that
 *   rendered it, so a tap inside a drawer opened from a clickable row would still reach
 *   the row's own onClick (expand, navigate). Only clicks: stopping keydown here would
 *   also stop it reaching the window listeners the overlays use for Escape. React stops
 *   the browser's event too, at <body>, so a click listener on document or window never
 *   hears a click inside an overlay; nothing in the apps listens for clicks there.
 */
export function Portal({ children }: { children: React.ReactNode }) {
  const mounted = React.useSyncExternalStore(subscribeNever, onClient, onServer);
  const vars = React.useContext(ThemeVarsContext);
  if (!mounted) return null;
  return createPortal(
    // `contents` makes the wrapper generate no box of its own, so it cannot become the
    // stacking context or containing block this component exists to escape.
    <div className="contents" style={vars as React.CSSProperties} onClick={stopClick}>
      {children}
    </div>,
    document.body,
  );
}
