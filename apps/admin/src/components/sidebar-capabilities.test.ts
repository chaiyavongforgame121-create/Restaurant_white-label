import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

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
