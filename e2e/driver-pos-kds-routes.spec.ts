import { test, expect } from '@playwright/test';

/**
 * Route smoke test: every screen loads without a 5xx or an uncaught page error.
 *
 * The kitchen and counter suites used to point at :3002 and :3003, the standalone
 * `apps/kds` and `apps/pos`. Those apps were merged into `apps/admin` as /kitchen and
 * /counter and removed from the pnpm workspace, so nothing can start those ports any
 * more — the tests could only ever fail. They now hit the surfaces that actually ship.
 *
 * Both admin surfaces redirect an unauthenticated visitor to /login, which is itself the
 * assertion worth making: they must be gated, and they must gate without crashing.
 */
const BRANCH = '44444444-4444-4444-4444-444444444444';

const SUITES = [
  {
    base: 'http://localhost:3001',
    name: 'driver',
    routes: ['/login', '/app/home', '/app/active', '/app/history', '/app/earnings', '/app/profile', '/app/training'],
  },
  {
    base: 'http://localhost:3004',
    name: 'kitchen',
    routes: [`/kitchen/${BRANCH}`, `/kitchen/${BRANCH}?station=hot`, `/kitchen/${BRANCH}?station=bar`],
  },
  {
    base: 'http://localhost:3004',
    name: 'counter',
    routes: ['/login', `/counter/${BRANCH}`, `/counter/${BRANCH}/recent`],
  },
];

for (const suite of SUITES) {
  test.describe(`${suite.name} routes (no crashes)`, () => {
    for (const route of suite.routes) {
      test(`${suite.name} ${route} returns 2xx/3xx without errors`, async ({ page }) => {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        const response = await page.goto(suite.base + route, { waitUntil: 'domcontentloaded' });
        expect(response, `no response for ${route}`).not.toBeNull();
        expect(response!.status(), `status for ${route}`).toBeLessThan(500);
        await page.waitForTimeout(1500);
        expect(errors, `pageerrors on ${route}: ${errors.join(' | ')}`).toEqual([]);
      });
    }
  });
}
