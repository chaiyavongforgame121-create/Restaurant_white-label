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

    // Password is the default mode, not the magic link: this test asserted a
    // "Send sign-in link" button, which is now behind the "Email me a link instead"
    // toggle. Both doors are checked, because the fallback is what a merchant reaches
    // for once a password stops working.
    test('login form offers password sign-in, and a link as fallback', async ({ page }) => {
      await page.goto('http://localhost:3004');
      await page.waitForLoadState('networkidle');
      await expect(page.getByPlaceholder(/owner@/i)).toBeVisible();
      await expect(page.getByPlaceholder(/your password/i)).toBeVisible();
      await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
      await expect(page.getByRole('link', { name: /forgot password/i })).toBeVisible();

      await page.getByRole('button', { name: /email me a link instead/i }).click();
      await expect(page.getByRole('button', { name: /send sign-in link/i })).toBeVisible();
      await expect(page.getByPlaceholder(/your password/i)).toBeHidden();
    });
  });
}
