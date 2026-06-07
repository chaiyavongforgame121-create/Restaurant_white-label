import { test, expect } from '@playwright/test';

/**
 * E2E: admin app login screen renders and the onboarding wizard mounts.
 * Requires `pnpm dev:admin` running.
 */
test.describe('admin smoke', () => {
  test.use({ baseURL: 'http://localhost:3004' });

  test('login page renders', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('heading')).toBeVisible({ timeout: 10_000 });
  });

  test('onboarding wizard step 1', async ({ page }) => {
    await page.goto('/onboarding');
    await expect(page.getByText(/restaurant/i).first()).toBeVisible({ timeout: 10_000 });
  });
});
