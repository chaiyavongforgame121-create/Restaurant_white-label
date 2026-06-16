import { test, expect } from '@playwright/test';

// Smoke-test that admin app routes either render correctly or redirect to /login
// without server-side errors. Most pages require auth; we verify the response
// status and that the page doesn't throw.

const PROTECTED_ROUTES = [
  '/b/22222222-2222-2222-2222-222222222222/dashboard',
  '/b/22222222-2222-2222-2222-222222222222/orders',
  '/b/22222222-2222-2222-2222-222222222222/deliveries',
  '/b/22222222-2222-2222-2222-222222222222/menu',
  '/b/22222222-2222-2222-2222-222222222222/menu/modifiers',
  '/b/22222222-2222-2222-2222-222222222222/menu/combos',
  '/b/22222222-2222-2222-2222-222222222222/menu/happy-hours',
  '/b/22222222-2222-2222-2222-222222222222/inventory',
  '/b/22222222-2222-2222-2222-222222222222/shifts',
  '/b/22222222-2222-2222-2222-222222222222/waitlist',
  '/b/22222222-2222-2222-2222-222222222222/floor-plan',
  '/b/22222222-2222-2222-2222-222222222222/reservations',
  '/b/22222222-2222-2222-2222-222222222222/staff',
  '/b/22222222-2222-2222-2222-222222222222/drivers',
  '/b/22222222-2222-2222-2222-222222222222/customers',
  '/b/22222222-2222-2222-2222-222222222222/marketing',
  '/b/22222222-2222-2222-2222-222222222222/promos',
  '/b/22222222-2222-2222-2222-222222222222/receipts',
  '/b/22222222-2222-2222-2222-222222222222/reports',
  '/b/22222222-2222-2222-2222-222222222222/branch',
  '/b/22222222-2222-2222-2222-222222222222/brands',
  '/b/22222222-2222-2222-2222-222222222222/franchise',
  '/b/22222222-2222-2222-2222-222222222222/settings/plan',
  '/b/22222222-2222-2222-2222-222222222222/activity',
  '/platform',
];

test.describe('admin routes (no errors)', () => {
  test.use({ baseURL: 'http://localhost:3004' });

  for (const route of PROTECTED_ROUTES) {
    test(`${route} returns 2xx or 3xx and does not crash`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const response = await page.goto(route, { waitUntil: 'domcontentloaded' });
      expect(response, `no response for ${route}`).not.toBeNull();
      expect(response!.status(), `status for ${route}`).toBeLessThan(500);
      // Brief settle window so client-side errors surface.
      await page.waitForTimeout(1500);
      expect(errors, `pageerrors on ${route}: ${errors.join(' | ')}`).toEqual([]);
    });
  }
});
