/**
 * What a signed-in person's access at one restaurant is made of, for StaffAccessWatcher.
 *
 * Kept apart from the component so the comparison can be tested without a browser, and so the
 * rule that decides a forced reload lives in one place: only the fields that change what
 * my_capabilities answers count. updated_at, a PIN or an address can change without anything
 * on screen being wrong, and reloading a kitchen board mid-service for those would be noise.
 */
export interface StaffAccessRow {
  id: string;
  role: string;
  status: string;
  branch_id: string | null;
}

/** sessionStorage key written as a forced reload unloads the page, read (and cleared) after it
 *  to say why. It holds whose access changed and when (encodeAccessNotice). */
export const ACCESS_CHANGED_FLAG = 'favornoms:staff-access-changed';

/** sessionStorage key holding when the last forced reload happened; it outlives the note. */
export const ACCESS_RELOADED_AT = 'favornoms:staff-access-reloaded-at';

/** A second forced reload waits at least this long after the one before it. */
export const MIN_RELOAD_GAP_MS = 10_000;

/** The note after a reload is only shown this soon after the page went. */
export const ACCESS_NOTICE_MAX_AGE_MS = 60_000;

/** A forced reload waits until nobody has touched the screen for this long... */
export const RELOAD_QUIET_MS = 3_000;

/** ...and while a modal is open, but never longer than this after the change was noticed. */
export const RELOAD_MAX_DEFER_MS = 30_000;

/** How often an open modal is looked at again while a reload waits for it to close. */
export const RELOAD_MODAL_POLL_MS = 1_000;

/**
 * How long to wait before a forced reload. Two changes in a row (a role, then a branch) each
 * reload, but never back to back: if the two reads ever disagreed for a reason nobody foresaw,
 * this turns a reload loop into one reload every few seconds instead of a frozen tablet.
 */
export function nextReloadDelay(lastAt: number | null, now: number): number {
  if (lastAt === null || !Number.isFinite(lastAt) || lastAt > now) return 0;
  return Math.max(0, lastAt + MIN_RELOAD_GAP_MS - now);
}

/**
 * How much longer a due reload should hold off, 0 meaning now. A modal is where work is in
 * flight: the till's payment sheet stays up while place-order runs, and a reload then would
 * leave an order the kitchen has and a till that shows an empty cart, which reads as "ring it
 * up again". A tap or key press in the last few seconds means someone is mid-action. Either
 * way the wait is capped, so the change always lands; the database already refuses whatever
 * the old role may no longer do, so the wait never widens what anyone can do.
 */
export function reloadWait(state: {
  modalOpen: boolean;
  lastInputAt: number | null;
  requestedAt: number;
  now: number;
}): number {
  const { modalOpen, lastInputAt, requestedAt, now } = state;
  const deferLeft = requestedAt + RELOAD_MAX_DEFER_MS - now;
  if (deferLeft <= 0) return 0;
  if (modalOpen) return Math.min(RELOAD_MODAL_POLL_MS, deferLeft);
  if (lastInputAt === null || lastInputAt > now) return 0;
  const quietLeft = lastInputAt + RELOAD_QUIET_MS - now;
  return quietLeft > 0 ? Math.min(quietLeft, deferLeft) : 0;
}

/**
 * Whether a row decides what this person may do at one branch: my_capabilities(branch) reads
 * the rows at that branch, the rows with no branch, and owner rows (an owner row names the
 * branch the owner signed up at but reaches them all).
 */
export function rowReachesBranch(
  row: Partial<Pick<StaffAccessRow, 'role' | 'branch_id'>>,
  branchId: string,
): boolean {
  return row.role === 'owner' || (row.branch_id ?? null) === null || row.branch_id === branchId;
}

/** The rows a screen compares: all of them, or, for a screen that serves one branch, only the
 *  ones that reach it. */
export function rowsInScope(
  rows: readonly StaffAccessRow[],
  branchId: string | null,
): StaffAccessRow[] {
  return branchId === null ? [...rows] : rows.filter((r) => rowReachesBranch(r, branchId));
}

/** Order-independent summary of a person's rows. Two reads of the same state always agree. */
export function staffAccessFingerprint(rows: readonly StaffAccessRow[]): string {
  return rows
    .map((r) => `${r.id}:${r.role}:${r.status}:${r.branch_id ?? '*'}`)
    .sort()
    .join('|');
}

/**
 * True when a row that just arrived over realtime (an INSERT or UPDATE of one of this person's
 * rows) differs from what the page was rendered with in a way that changes access: a row not
 * seen before, or a different role, status or branch. With a branch, a change that reaches
 * that branch neither before nor after (the person's row at another branch) is not this
 * screen's: a kitchen board at one branch keeps its fullscreen and its sound when the owner
 * changes what the same person does at the other.
 */
export function rowChangesAccess(
  known: readonly StaffAccessRow[],
  incoming: Partial<StaffAccessRow> & { id?: string },
  branchId: string | null = null,
): boolean {
  if (!incoming.id) return false;
  const before = known.find((r) => r.id === incoming.id);
  if (
    branchId !== null &&
    !(before && rowReachesBranch(before, branchId)) &&
    !rowReachesBranch(incoming, branchId)
  ) {
    return false;
  }
  if (!before) return true;
  return (
    before.role !== incoming.role ||
    before.status !== incoming.status ||
    (before.branch_id ?? null) !== (incoming.branch_id ?? null)
  );
}

/** What ACCESS_CHANGED_FLAG holds: whose access changed, and when the page went. */
export function encodeAccessNotice(userId: string, at: number): string {
  return JSON.stringify({ u: userId, at });
}

/**
 * Whether the note left by a forced reload is this person's and recent. A reload that lands on
 * the sign-in page (the session went too) leaves the note in the tab, and whoever signs in
 * there next must not be told the restaurant changed their access.
 */
export function accessNoticeApplies(raw: string | null, userId: string, now: number): boolean {
  if (!raw) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object') return false;
  const { u, at } = parsed as { u?: unknown; at?: unknown };
  return (
    u === userId &&
    typeof at === 'number' &&
    Number.isFinite(at) &&
    at <= now &&
    now - at <= ACCESS_NOTICE_MAX_AGE_MS
  );
}
