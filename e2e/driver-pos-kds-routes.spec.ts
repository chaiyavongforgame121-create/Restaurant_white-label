import { test, expect } from '@playwright/test';

const SUITES = [
  {
    base: 'http://localhost:3001',
    name: 'driver',
    routes: ['/login', '/app/home', '/app/active', '/app/history', '/app/earnings', '/app/profile', '/app/training'],
  },
  {
    base: 'http://localhost:3002',
    name: 'kds',
    routes: ['/b/22222222-2222-2222-2222-222222222222', '/b/22222222-2222-2222-2222-222222222222?station=hot', '/b/22222222-2222-2222-2222-222222222222?station=bar'],
  },
  {
    base: 'http://localhost:3003',
    name: 'pos',
    routes: ['/login', '/b/22222222-2222-2222-2222-222222222222', '/b/22222222-2222-2222-2222-222222222222/recent'],
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
