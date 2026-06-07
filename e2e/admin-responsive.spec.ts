import { test, expect } from '@playwright/test';

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'ipad-768', width: 768, height: 1024 },
  { name: 'laptop-1440', width: 1440, height: 900 },
];

for (const vp of VIEWPORTS) {
  test.describe(`admin @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('login page renders without horizontal overflow', async ({ page }) => {
      await page.goto('http://localhost:3004');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText(/sign in to manage|favornoms admin/i).first()).toBeVisible({ timeout: 10_000 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(clientWidth + 1);
    });

    test('login form has email input and submit', async ({ page }) => {
      await page.goto('http://localhost:3004');
      await page.waitForLoadState('networkidle');
      await expect(page.getByPlaceholder(/owner@/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /send sign-in/i })).toBeVisible();
    });
  });
}
