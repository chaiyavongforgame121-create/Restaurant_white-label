import { test, expect, devices } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile-375', width: 375, height: 812 },
  { name: 'tablet-768', width: 768, height: 1024 },
  { name: 'desktop-1440', width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test.describe(`web responsive @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('landing page renders without horizontal overflow', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByRole('heading', { name: /your restaurant/i })).toBeVisible();
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('help page renders 6 topic cards', async ({ page }) => {
      await page.goto('/help');
      await expect(page.getByRole('heading', { name: /help center/i })).toBeVisible();
      const cards = page.getByRole('link', { name: /placing an order|cancel|delivery|promos|account|contact/i });
      expect(await cards.count()).toBeGreaterThanOrEqual(6);
    });

    test('branch menu page renders without overflow', async ({ page }) => {
      await page.goto('/r/coastal-grill/brooklyn');
      // wait for hero
      await page.waitForLoadState('networkidle');
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(clientWidth + 1);
    });
  });
}
