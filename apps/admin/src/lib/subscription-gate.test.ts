import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DENIED_ENTITLEMENTS, type Entitlements } from '@favornoms/shared';
import { getBranchAccess } from './capabilities';
import {
  branchLayoutRedirect,
  planPath,
  subscriptionGateFrom,
  subscriptionRedirect,
  suspendedPath,
  type WhileLocked,
} from './subscription-gate';

/**
 * What an ended subscription does to every screen (docs: the expired-restaurant map, §4).
 *
 * The decision itself is two pure functions; which screen asks with which rule is read from the
 * screens' own source, so a page added later, or a rule changed on one screen, shows up here as a
 * row of the table rather than as a merchant who can click around the lock (D1).
 */

vi.mock('server-only', () => ({}));

const nav = vi.hoisted(() => ({
  redirect: (to: string): never => {
    throw Object.assign(new Error(`redirect ${to}`), { to });
  },
  notFound: (): never => {
    throw new Error('notFound');
  },
}));
vi.mock('next/navigation', () => nav);

const db = vi.hoisted(() => ({
  entitlements: null as unknown,
  platformAdmin: false,
  client: null as unknown,
}));
vi.mock('@favornoms/database/queries', () => ({
  getEntitlementsForBranch: vi.fn(async () => db.entitlements),
  isPlatformAdmin: vi.fn(async () => db.platformAdmin),
}));
vi.mock('@favornoms/database/server', () => ({
  getServerClient: vi.fn(async () => db.client),
}));

const B = 'b1';
const PLAN = `/b/${B}/settings/plan`;
const SUSPENDED = `/suspended/${B}`;

function ents(over: Partial<Entitlements>): Entitlements {
  return { ...DENIED_ENTITLEMENTS, restaurantId: 'r1', status: 'active', ...over } as Entitlements;
}
const PAID = ents({ entitled: true, entitledThrough: '2099-01-01T00:00:00Z' });
const EXPIRED = ents({ entitled: false, status: 'expired' });
const READ_FAILED = DENIED_ENTITLEMENTS;

/** Representative capability sets (public.role_capabilities): what matters here is whether the
 *  back office opens, and whether the person works at the restaurant at all. */
const ROLES = {
  owner: ['backoffice.access', 'dashboard.view', 'billing.manage', 'kitchen.access', 'counter.access'],
  admin: ['backoffice.access', 'dashboard.view', 'kitchen.access', 'counter.access'],
  manager: ['backoffice.access', 'dashboard.view', 'kitchen.access', 'counter.access'],
  cashier: ['backoffice.access', 'dashboard.view', 'counter.access', 'kitchen.status', 'receipt.reprint'],
  server: ['counter.access', 'kitchen.status'],
  staff: ['counter.access'],
  kitchen: ['kitchen.access', 'kitchen.status'],
  stranger: [],
} as const satisfies Record<string, readonly string[]>;
type Role = keyof typeof ROLES;
const caps = (role: Role) => new Set<string>(ROLES[role]);

describe('subscriptionGateFrom', () => {
  it.each([
    ['paid up', PAID, false, { known: true, ended: false, locked: false }],
    ['expired', EXPIRED, false, { known: true, ended: true, locked: true }],
    ['expired, platform admin', EXPIRED, true, { known: true, ended: true, locked: false }],
    // D8: the fail-closed fallback names no restaurant. A failed read locks nobody out.
    ['read failed', READ_FAILED, false, { known: false, ended: false, locked: false }],
    ['read failed, platform admin', READ_FAILED, true, { known: false, ended: false, locked: false }],
  ] as const)('%s', (_name, entitlements, platformAdmin, expected) => {
    expect(subscriptionGateFrom(entitlements, platformAdmin)).toMatchObject({ ...expected, platformAdmin });
  });
});

describe('subscriptionRedirect (getBranchAccess)', () => {
  const policies: Array<WhileLocked | undefined> = [undefined, 'allow', 'ordersInProgress'];
  const roles = Object.keys(ROLES) as Role[];

  it('never sends anyone anywhere while the subscription is live (or unknown)', () => {
    for (const role of roles)
      for (const whileLocked of policies)
        for (const ordersInProgress of [false, true])
          expect(
            subscriptionRedirect({ branchId: B, locked: false, capabilities: caps(role), whileLocked, ordersInProgress }),
          ).toBeNull();
  });

  // locked × role × screen rule × orders still in progress
  const table: Array<[Role, WhileLocked | undefined, boolean, string | null]> = [
    // Every back-office page, the till and the counter's Tables: no exception.
    ['owner', undefined, false, PLAN],
    ['owner', undefined, true, PLAN],
    ['admin', undefined, false, PLAN],
    ['manager', undefined, false, PLAN],
    ['cashier', undefined, true, PLAN],
    ['server', undefined, true, SUSPENDED],
    ['staff', undefined, false, SUSPENDED],
    ['kitchen', undefined, false, SUSPENDED],
    // The kitchen board and Recent: open while orders placed before the end are finished.
    ['owner', 'ordersInProgress', true, null],
    ['owner', 'ordersInProgress', false, PLAN],
    ['cashier', 'ordersInProgress', true, null],
    ['cashier', 'ordersInProgress', false, PLAN],
    ['kitchen', 'ordersInProgress', true, null],
    ['kitchen', 'ordersInProgress', false, SUSPENDED],
    ['server', 'ordersInProgress', true, null],
    ['server', 'ordersInProgress', false, SUSPENDED],
    // The branch layout, Plan & billing and /suspended decide for themselves.
    ['owner', 'allow', false, null],
    ['server', 'allow', false, null],
    // Someone who does not work here keeps the screen's own access-denied card: no billing status.
    ['stranger', undefined, false, null],
    ['stranger', 'ordersInProgress', false, null],
  ];
  it.each(table)('locked: %s on a %s screen, orders in progress %s -> %s', (role, whileLocked, ordersInProgress, expected) => {
    expect(
      subscriptionRedirect({ branchId: B, locked: true, capabilities: caps(role), whileLocked, ordersInProgress }),
    ).toBe(expected);
  });

  it('names the branch it was asked about', () => {
    expect(planPath('x')).toBe('/b/x/settings/plan');
    expect(suspendedPath('x')).toBe('/suspended/x');
  });
});

describe('branchLayoutRedirect (the full-load fast path)', () => {
  const table: Array<[Role, string, string | null]> = [
    ['owner', `/b/${B}/dashboard`, PLAN],
    ['owner', `/b/${B}/menu/combos`, PLAN],
    // Plan & billing is never sent to itself: that would loop.
    ['owner', PLAN, null],
    ['owner', `${PLAN}/anything`, null],
    ['cashier', `/b/${B}/orders`, PLAN],
    ['cashier', PLAN, null],
    // No back office: the ask-the-owner page, not "No admin access" (D5).
    ['server', `/b/${B}/dashboard`, SUSPENDED],
    ['server', PLAN, SUSPENDED],
    ['kitchen', PLAN, SUSPENDED],
    ['stranger', `/b/${B}/dashboard`, null],
    // No address header: the page under the layout decides, which cannot loop.
    ['owner', '', null],
  ];
  it.each(table)('locked: %s at %s -> %s', (role, pathname, expected) => {
    expect(branchLayoutRedirect({ branchId: B, pathname, locked: true, capabilities: caps(role) })).toBe(expected);
  });

  it('does nothing while the subscription is live', () => {
    for (const role of Object.keys(ROLES) as Role[])
      expect(branchLayoutRedirect({ branchId: B, pathname: `/b/${B}/dashboard`, locked: false, capabilities: caps(role) })).toBeNull();
  });
});

// --- which screen asks with which rule, from the screens themselves -------------------------

const APP = path.resolve(__dirname, '../app');

function files(dir: string, names: string[]): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...files(full, names));
    else if (names.includes(entry.name)) out.push(full);
  }
  return out;
}

type Rule = 'none' | WhileLocked;
function ruleOf(file: string): Rule {
  const src = fs.readFileSync(file, 'utf8');
  const rules = Array.from(src.matchAll(/whileLocked: '([a-zA-Z]+)'/g), (m) => m[1] as WhileLocked);
  expect(new Set(rules).size, `${file} asks with one rule`).toBeLessThanOrEqual(1);
  return rules[0] ?? 'none';
}
const rel = (file: string) => path.relative(APP, file).split(path.sep).join('/');

describe('every screen behind a branch', () => {
  const gated = [
    ...files(path.join(APP, 'b'), ['page.tsx', 'layout.tsx']),
    ...files(path.join(APP, 'counter'), ['page.tsx', 'layout.tsx']),
    ...files(path.join(APP, 'kitchen'), ['page.tsx', 'layout.tsx']),
    ...files(path.join(APP, 'suspended'), ['page.tsx', 'layout.tsx']),
  ];

  it('finds the screens it is checking', () => {
    expect(gated.length).toBeGreaterThan(30);
  });

  it.each(gated.map((f) => [rel(f)] as const))('%s goes through getBranchAccess', (file) => {
    expect(fs.readFileSync(path.join(APP, file), 'utf8')).toContain('getBranchAccess(');
  });

  const EXCEPTIONS: Record<string, Rule> = {
    // Decide for themselves: the layout over Plan & billing, the page itself, and the lock page.
    'b/[branchId]/layout.tsx': 'allow',
    'b/[branchId]/settings/plan/page.tsx': 'allow',
    'suspended/[branchId]/page.tsx': 'allow',
    // Open while orders placed before the end are being finished (owner decision 2026-10-27).
    'kitchen/[branchId]/layout.tsx': 'ordersInProgress',
    'kitchen/[branchId]/page.tsx': 'ordersInProgress',
    'counter/[branchId]/layout.tsx': 'ordersInProgress',
    'counter/[branchId]/recent/page.tsx': 'ordersInProgress',
  };
  it.each(gated.map((f) => [rel(f)] as const))('%s asks with the expected rule', (file) => {
    expect(ruleOf(path.join(APP, file))).toBe(EXCEPTIONS[file] ?? 'none');
  });
});

describe('where each person ends up, by address (locked × role × path × orders in progress)', () => {
  const rule = (file: string) => ruleOf(path.join(APP, file));

  /** The layout's answer, then the page's: whichever redirects first wins; null renders. */
  function destination(pathname: string, role: Role, locked: boolean, ordersInProgress: boolean): string | null {
    const capabilities = caps(role);
    const ask = (file: string) =>
      subscriptionRedirect({ branchId: B, locked, capabilities, whileLocked: rule(file) === 'none' ? undefined : (rule(file) as WhileLocked), ordersInProgress });
    if (pathname.startsWith(`/b/${B}/`)) {
      const page = pathname === PLAN ? 'b/[branchId]/settings/plan/page.tsx' : `b/[branchId]/${pathname.slice(`/b/${B}/`.length)}/page.tsx`;
      return branchLayoutRedirect({ branchId: B, pathname, locked, capabilities }) ?? ask(page);
    }
    if (pathname.startsWith(`/kitchen/${B}`)) return ask('kitchen/[branchId]/layout.tsx') ?? ask('kitchen/[branchId]/page.tsx');
    if (pathname.startsWith(`/counter/${B}`)) {
      const sub = pathname.slice(`/counter/${B}`.length);
      const page = sub ? `counter/[branchId]${sub}/page.tsx` : 'counter/[branchId]/page.tsx';
      return ask('counter/[branchId]/layout.tsx') ?? ask(page);
    }
    throw new Error(`no route for ${pathname}`);
  }

  const DASH = `/b/${B}/dashboard`;
  const MENU = `/b/${B}/menu`;
  const KITCHEN = `/kitchen/${B}`;
  const TILL = `/counter/${B}`;
  const RECENT = `/counter/${B}/recent`;
  const TABLES = `/counter/${B}/tables`;

  const table: Array<[string, Role, boolean, string | null]> = [
    // The back office: Plan & billing for whoever has it, the ask-the-owner page for the rest.
    [DASH, 'owner', false, PLAN],
    [MENU, 'manager', true, PLAN],
    [DASH, 'cashier', false, PLAN],
    [DASH, 'server', false, SUSPENDED],
    [DASH, 'kitchen', true, SUSPENDED],
    [PLAN, 'owner', false, null],
    [PLAN, 'admin', true, null],
    [PLAN, 'cashier', false, null],
    [PLAN, 'staff', false, SUSPENDED],
    // The kitchen board: open while there is still something on it.
    [KITCHEN, 'kitchen', true, null],
    [KITCHEN, 'kitchen', false, SUSPENDED],
    [KITCHEN, 'owner', true, null],
    [KITCHEN, 'owner', false, PLAN],
    // The till takes new orders: locked whatever is still cooking.
    [TILL, 'cashier', true, PLAN],
    [TILL, 'server', true, SUSPENDED],
    [TILL, 'staff', false, SUSPENDED],
    // Recent: open while orders are being finished, for lookups and reprints.
    [RECENT, 'cashier', true, null],
    [RECENT, 'server', true, null],
    [RECENT, 'server', false, SUSPENDED],
    [RECENT, 'cashier', false, PLAN],
    // Tables settles bills and seats new tables: locked (D4).
    [TABLES, 'cashier', true, PLAN],
    [TABLES, 'server', true, SUSPENDED],
    // Strangers keep the screen's own access-denied card.
    [DASH, 'stranger', false, null],
    [KITCHEN, 'stranger', false, null],
    [TILL, 'stranger', true, null],
  ];
  it.each(table)('%s as %s (orders in progress: %s) -> %s', (pathname, role, orders, expected) => {
    expect(destination(pathname, role, true, orders)).toBe(expected);
  });

  it('lets everyone through while the subscription is live', () => {
    for (const [pathname, role, orders] of table) expect(destination(pathname, role, false, orders)).toBeNull();
  });
});

// --- getBranchAccess itself, against a fake client ------------------------------------------

interface Fake {
  caps: string[];
  orders: { data: Array<{ id: string }> | null; error: { message: string } | null };
  ordersAsked: number;
  /** Every filter the last orders query was built with, as [method, ...args]. */
  ordersQuery?: unknown[][];
}

function fakeClient(f: Fake) {
  const builder = (table: string) => {
    const result = () => {
      if (table === 'branches') return { data: { id: B, restaurant_id: 'r1', name: 'Main' }, error: null };
      if (table === 'orders') {
        f.ordersAsked += 1;
        return f.orders;
      }
      return { data: [], error: null };
    };
    const chain: Record<string, unknown> = {};
    if (table === 'orders') f.ordersQuery = [];
    for (const m of ['select', 'eq', 'or', 'in', 'limit', 'order']) {
      chain[m] = (...args: unknown[]) => {
        if (table === 'orders') f.ordersQuery?.push([m, ...args]);
        return chain;
      };
    }
    chain.maybeSingle = async () => result();
    chain.then = (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
      Promise.resolve(result()).then(resolve, reject);
    return chain;
  };
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'u1', email: 'u1@example.test' } } }) },
    from: builder,
    rpc: async (fn: string) => (fn === 'my_capabilities' ? { data: f.caps, error: null } : { data: null, error: null }),
  };
}

async function where(call: () => Promise<unknown>): Promise<string | null> {
  try {
    await call();
    return null;
  } catch (e) {
    const to = (e as { to?: string }).to;
    if (typeof to === 'string') return to;
    throw e;
  }
}

describe('getBranchAccess', () => {
  let fake: Fake;
  beforeEach(() => {
    fake = { caps: [...ROLES.owner], orders: { data: [], error: null }, ordersAsked: 0 };
    db.client = fakeClient(fake);
    db.entitlements = EXPIRED;
    db.platformAdmin = false;
  });

  it('sends a locked owner to Plan & billing from any page', async () => {
    expect(await where(() => getBranchAccess(B, `/b/${B}/menu`))).toBe(PLAN);
  });

  it('lets the caller handle it with allow, and says it is locked', async () => {
    const access = await getBranchAccess(B, PLAN, { whileLocked: 'allow' });
    expect(access.subscription).toMatchObject({ locked: true, ended: true, known: true });
  });

  it('sends a locked cook to /suspended when nothing is left to finish', async () => {
    fake.caps = [...ROLES.kitchen];
    expect(await where(() => getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' }))).toBe(SUSPENDED);
    expect(fake.ordersAsked).toBe(1);
  });

  it('keeps the board open while orders are in progress', async () => {
    fake.caps = [...ROLES.kitchen];
    fake.orders = { data: [{ id: 'o1' }], error: null };
    const access = await getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' });
    expect(access.subscription.locked).toBe(true);
  });

  it('counts only orders an open screen can still finish', async () => {
    fake.caps = [...ROLES.kitchen];
    fake.orders = { data: [{ id: 'o1' }], error: null };
    await getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' });
    const q = fake.ordersQuery ?? [];
    // A ticket with lines, as the board shows one (isOnBoard).
    expect(q).toContainEqual(['select', 'id, order_items!inner(id)']);
    expect(q).toContainEqual(['in', 'status', ['pending', 'confirmed', 'preparing', 'ready']]);
    // A held booking counts: the board shows it in its Scheduled drawer and its release brings
    // it onto the board.
    expect(q.some(([m, col]) => m === 'eq' && col === 'held')).toBe(false);
    // Recent's window, placed or booked for: a forgotten ticket from last month does not keep
    // the board open, a pre-order placed days ago and due today (or later) does.
    const ors = q.filter(([m]) => m === 'or').map(([, f]) => String(f));
    const windowFilter = ors.find((f) => f.startsWith('created_at.gte.'));
    expect(windowFilter).toMatch(/^created_at\.gte\.(.+),scheduled_for\.gte\.\1$/);
    const since = Date.parse(windowFilter!.slice('created_at.gte.'.length).split(',')[0]!);
    expect(Math.abs(Date.now() - 24 * 3_600_000 - since)).toBeLessThan(60_000);
    // A storefront transfer waits for its slip on the locked Orders page; a till sale waiting for
    // its payment is settled from Recent.
    expect(ors).toContain('awaiting_payment.eq.false,source.in.(counter,pos)');
  });

  it('keeps the board open when the orders cannot be read', async () => {
    fake.caps = [...ROLES.kitchen];
    fake.orders = { data: null, error: { message: 'timeout' } };
    expect(await where(() => getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' }))).toBeNull();
  });

  it('asks about orders only when they decide something', async () => {
    db.entitlements = PAID;
    await getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' });
    db.entitlements = EXPIRED;
    await where(() => getBranchAccess(B, `/b/${B}/menu`));
    fake.caps = [];
    await getBranchAccess(B, `/kitchen/${B}`, { whileLocked: 'ordersInProgress' });
    expect(fake.ordersAsked).toBe(0);
  });

  it('leaves a stranger to the access-denied card', async () => {
    fake.caps = [];
    const access = await getBranchAccess(B, `/b/${B}/dashboard`);
    expect(access.capabilities.size).toBe(0);
  });

  it('never locks a platform admin', async () => {
    db.platformAdmin = true;
    const access = await getBranchAccess(B, `/b/${B}/menu`);
    expect(access.subscription).toMatchObject({ locked: false, ended: true, platformAdmin: true });
  });

  it('does not lock anyone out on a failed read (D8)', async () => {
    db.entitlements = READ_FAILED;
    const access = await getBranchAccess(B, `/b/${B}/menu`);
    expect(access.subscription).toMatchObject({ locked: false, known: false });
  });

  it('lets a paying restaurant through', async () => {
    db.entitlements = PAID;
    expect(await where(() => getBranchAccess(B, `/counter/${B}`))).toBeNull();
  });
});
