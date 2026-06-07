import { test, expect } from '@playwright/test';

// Driver app is mobile-first; primary device is 390/414 phones.
const VIEWPORTS = [
  { name: 'iphone-se-375', width: 375, height: 667 },
  { name: 'pixel-7-412', width: 412, height: 915 },
];

for (const vp of VIEWPORTS) {
  test.describe(`driver @ ${vp.name}`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test('login renders without horizontal overflow', async ({ page }) => {
      await page.goto('http://localhost:3001');
      await page.waitForLoadState('networkidle');
      await expect(page.getByText(/welcome|sign in|driver|enter phone/i).first()).toBeVisible({ timeout: 10_000 });
      const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
      const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
      expect(scrollWidth, `no horizontal scroll at ${vp.width}px`).toBeLessThanOrEqual(clientWidth + 1);
    });
  });
}
