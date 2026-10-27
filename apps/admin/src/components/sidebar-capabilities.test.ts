import fs from 'node:fs';
import path from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DENIED_ENTITLEMENTS, type Entitlements } from '@favornoms/shared';
import { Sidebar } from './sidebar';

// The sidebar's locked mode is rendered for real below; these stand in for the app around it.
vi.mock('next-intl', () => ({
  useTranslations:
    (ns?: string) =>
    (key: string, values?: Record<string, unknown>) =>
      `${ns ? `${ns}.` : ''}${key}${values ? JSON.stringify(values) : ''}`,
}));
vi.mock('next/navigation', () => ({
  usePathname: () => '/b/b1/settings/plan',
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
}));
vi.mock('next/link', async () => {
  const React = await import('react');
  return {
    default: ({ href, children, onClick: _onClick, ...rest }: Record<string, unknown>) =>
      React.createElement('a', { href, ...rest }, children as never),
  };
});
vi.mock('@favornoms/database/client', () => ({ getBrowserClient: () => ({}) }));
vi.mock('@favornoms/database/queries', () => ({ isPlatformAdmin: async () => false }));
vi.mock('@/components/locale-switcher', async () => {
  const React = await import('react');
  return { LocaleSwitcher: () => React.createElement('div', { 'data-footer': 'language' }) };
});
vi.mock('./theme-toggle', async () => {
  const React = await import('react');
  return { ThemeToggle: () => React.createElement('div', { 'data-footer': 'theme' }) };
});
vi.mock('./sign-out', async () => {
  const React = await import('react');
  return { SignOutButton: () => React.createElement('div', { 'data-footer': 'sign-out' }) };
});

/**
 * The back office's doors and its signposts have to agree. A cashier passes the branch layout's
 * backoffice.access gate now (owner decision D1, 2026-10-16), so "anyone past the gate" is no longer
 * an owner, admin or manager: every page asks for its own capability, and every sidebar entry asks
 * for the same one, so an entry is shown exactly when its screen opens.
 */

const SIDEBAR = path.join(__dirname, 'sidebar.tsx');
const BRANCH_APP = path.resolve(__dirname, '../app/b/[branchId]');

interface Entry {
  path: string;
  capabilities: string[] | null;
}

/** The sidebar's `${base}/…` entries, with the capability (or capabilities) each one carries. */
function sidebarEntries(): Entry[] {
  const src = fs.readFileSync(SIDEBAR, 'utf8');
  const entries: Entry[] = [];
  for (const line of src.split(/\r?\n/)) {
    const href = /href: `\$\{base\}\/([^`]+)`/.exec(line);
    if (!href) continue;
    const list = /capability: \[([^\]]*)\]/.exec(line);
    const single = /capability: '([^']+)'/.exec(line);
    const capabilities = list
      ? Array.from(list[1]!.matchAll(/'([^']+)'/g), (m) => m[1]!)
      : single
        ? [single[1]!]
        : null;
    entries.push({ path: href[1]!, capabilities });
  }
  return entries;
}

function pageFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pageFiles(full));
    else if (entry.name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('the back-office sidebar', () => {
  const entries = sidebarEntries();

  it('finds the entries it is checking', () => {
    expect(entries.length).toBeGreaterThan(15);
    expect(entries.map((e) => e.path)).toEqual(expect.arrayContaining(['dashboard', 'qr', 'ratings', 'timelog']));
  });

  it('gives every entry a capability', () => {
    const bare = entries.filter((e) => !e.capabilities || e.capabilities.length === 0).map((e) => e.path);
    expect(bare).toEqual([]);
  });

  it.each(sidebarEntries().map((e) => [e.path, e] as const))(
    '%s asks for what its page asks for',
    (_path, entry) => {
      const file = path.join(BRANCH_APP, entry.path, 'page.tsx');
      // A page another change has not landed yet (the time log) is checked once it exists.
      if (!fs.existsSync(file)) return;
      const page = fs.readFileSync(file, 'utf8');
      for (const capability of entry.capabilities ?? []) {
        expect(page, `${entry.path} page checks ${capability}`).toContain(`can('${capability}')`);
      }
    },
  );
});

describe('every back-office page', () => {
  it.each(pageFiles(BRANCH_APP).map((f) => [path.relative(BRANCH_APP, f)] as const))(
    '%s checks a capability of its own',
    (rel) => {
      const page = fs.readFileSync(path.join(BRANCH_APP, rel), 'utf8');
      expect(page).toMatch(/\bcan\('[a-z.]+'\)/);
    },
  );
});

/**
 * The menu of a restaurant whose subscription has ended: Plan & billing and nothing else, because
 * every other screen sends the person there (D2). It is the one entry not filtered by its page's
 * capability: the owner renews there, and an admin, manager or cashier reads "ask the owner".
 */
describe('the locked sidebar', () => {
  const EXPIRED = { ...DENIED_ENTITLEMENTS, restaurantId: 'r1', status: 'expired' } as Entitlements;
  const PAID = {
    ...DENIED_ENTITLEMENTS,
    restaurantId: 'r1',
    status: 'active',
    entitled: true,
    entitledThrough: '2099-01-01T00:00:00Z',
    features: { delivery: true },
  } as Entitlements;
  const OWNER = ['backoffice.access', 'dashboard.view', 'orders.view', 'menu.manage', 'kitchen.access', 'counter.access', 'reports.view', 'hq.view', 'staff.manage', 'branch.settings', 'brand.edit', 'billing.manage', 'delivery.manage'];
  const CASHIER = ['backoffice.access', 'dashboard.view', 'counter.access', 'kitchen.status', 'customers.view'];

  function render(props: { locked?: boolean; capabilities: string[]; logoUrl?: string | null; entitlements?: Entitlements }) {
    return renderToStaticMarkup(
      createElement(Sidebar, {
        branchId: 'b1',
        branchName: 'Main',
        branches: [
          { id: 'b1', name: 'Main' },
          { id: 'b2', name: 'Second' },
        ],
        entitlements: props.entitlements ?? EXPIRED,
        capabilities: props.capabilities,
        logoUrl: props.logoUrl ?? null,
        locked: props.locked,
      }),
    );
  }
  const hrefs = (html: string) => Array.from(html.matchAll(/<a [^>]*href="([^"]+)"/g), (m) => m[1]!);
  const nav = (html: string) => /<nav[^>]*>([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? '';

  it.each([
    ['the owner', OWNER],
    ['a cashier, who has no billing.manage', CASHIER],
  ])('shows %s only Plan & billing, with the note', (_who, capabilities) => {
    const html = render({ locked: true, capabilities });
    expect(hrefs(nav(html))).toEqual(['/b/b1/settings/plan']);
    expect(nav(html)).toContain('shell.nav.planBilling');
    expect(nav(html)).toContain('shell.subscriptionLocked.sidebarNote');
    // No Advanced group to open.
    expect(html).not.toContain('shell.sections.advanced');
  });

  it.each([
    ['without a logo', null],
    ['with a logo', 'https://example.test/logo.png'],
  ])('sends the mark to Plan & billing, never the dashboard, %s', (_how, logoUrl) => {
    const html = render({ locked: true, capabilities: OWNER, logoUrl });
    expect(hrefs(html).every((h) => h === '/b/b1/settings/plan')).toBe(true);
    expect(html).not.toContain('/dashboard');
  });

  it('keeps the footer: language, theme and sign out', () => {
    const html = render({ locked: true, capabilities: CASHIER });
    for (const part of ['language', 'theme', 'sign-out']) expect(html).toContain(`data-footer="${part}"`);
  });

  it('marks itself, for the Plan & billing page to compare against', () => {
    expect(render({ locked: true, capabilities: OWNER })).toContain('data-subscription-locked="true"');
    expect(render({ capabilities: OWNER, entitlements: PAID })).toContain('data-subscription-locked="false"');
  });

  it('switches branch straight to the other branch’s Plan & billing', () => {
    const src = fs.readFileSync(SIDEBAR, 'utf8');
    expect(src).toContain("router.push(`/b/${e.target.value}/${locked ? 'settings/plan' : 'dashboard'}`)");
  });

  it('is the whole menu again when not locked', () => {
    const html = render({ capabilities: OWNER, entitlements: PAID });
    const links = hrefs(nav(html));
    expect(links).toEqual(expect.arrayContaining(['/b/b1/dashboard', '/b/b1/orders', '/b/b1/menu', '/kitchen/b1', '/counter/b1']));
    // Plan & billing is under Advanced, which starts closed.
    expect(links).not.toContain('/b/b1/settings/plan');
    expect(html).toContain('shell.sections.advanced');
    expect(hrefs(html)).toContain('/b/b1/dashboard');
  });
});
