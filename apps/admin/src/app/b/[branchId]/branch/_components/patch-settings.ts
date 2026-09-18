import * as React from 'react';
import type { Json } from '@favornoms/database/types';
import { getBrowserClient } from '@favornoms/database/client';

// Every Branch settings card used to save with `update({ settings: { ...settings, ...mine } })`,
// writing back the whole jsonb as it was when the page loaded. Two tabs, or the kitchen board's
// Pause button pressed while this page sat open, meant the later save silently reverted the
// other one (a paused kitchen came back on because Delivery settings was saved). The cards now
// send only the keys the merchant actually changed, and patch_branch_settings merges them into
// the row as it is at that moment, under the same branch.settings / kitchen.access checks.

/** Deep equality for JSON values. jsonb hands keys back in its own order, so comparing
 *  JSON.stringify output would call an untouched object "changed". */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJson(v, b[i]));
  }
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  const ka = Object.keys(ra).filter((k) => ra[k] !== undefined);
  const kb = Object.keys(rb).filter((k) => rb[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(rb, k) && sameJson(ra[k], rb[k]));
}

/** The entries of `next` whose value differs from what `current` (the settings the card was
 *  rendered with) holds. Undefined values are left out. */
export function changedSettings(
  current: Record<string, unknown> | null | undefined,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (value === undefined) continue;
    if (!sameJson(current?.[key], value)) out[key] = value;
  }
  return out;
}

/** Merges `patch` into branches.settings on the server. Nothing to change means no request. */
export async function patchBranchSettings(
  branchId: string,
  patch: Record<string, unknown>,
): Promise<{ error: { message: string; code?: string } | null }> {
  if (Object.keys(patch).length === 0) return { error: null };
  const { error } = await getBrowserClient().rpc('patch_branch_settings', {
    p_branch_id: branchId,
    p_patch: patch as Json,
  });
  return { error };
}

/**
 * What a card's controls were last in step with: the settings it was rendered with, then, after
 * each save, what that save wrote. Comparing with the rendered settings alone went wrong once a
 * card had saved: router.refresh() lands later, so undoing a change before it did (grid, then back
 * to list) matched the stale render, sent nothing, and said Saved while the row kept grid.
 *
 * The cards never re-read their controls from a refreshed render, so neither does this: a newer
 * render may carry another tab's or the kitchen board's change to a key this card shows, and that
 * key must still count as untouched here.
 */
export function createSettingsBaseline(initial: Record<string, unknown> | null | undefined) {
  let current: Record<string, unknown> = { ...(initial ?? {}) };
  return {
    /** The keys of `next` that differ from what the controls were last in step with. */
    diff: (next: Record<string, unknown>) => changedSettings(current, next),
    /** After a successful save: the controls now match `next`. */
    commit: (next: Record<string, unknown>) => {
      const defined = Object.fromEntries(Object.entries(next).filter(([, v]) => v !== undefined));
      current = { ...current, ...defined };
    },
  };
}

/**
 * A card's save: sends the keys of `next` that changed since the card was rendered or last saved,
 * then records `next` as saved. `initial` is read once, on the first render (pass a function to
 * compute it lazily).
 */
export function useSettingsPatch(
  branchId: string,
  initial: Record<string, unknown> | null | undefined | (() => Record<string, unknown>),
) {
  const baseline = React.useRef<ReturnType<typeof createSettingsBaseline> | null>(null);
  if (baseline.current === null) {
    baseline.current = createSettingsBaseline(typeof initial === 'function' ? initial() : initial);
  }
  // One save at a time: a second one diffs only after the first has landed and been recorded,
  // or it would compare with a baseline that is about to change under it.
  const queue = React.useRef<Promise<unknown>>(Promise.resolve());
  return React.useCallback(
    (next: Record<string, unknown>) => {
      const run = queue.current.then(async () => {
        const tracker = baseline.current!;
        const result = await patchBranchSettings(branchId, tracker.diff(next));
        if (!result.error) tracker.commit(next);
        return result;
      });
      queue.current = run.catch(() => undefined);
      return run;
    },
    [branchId],
  );
}
