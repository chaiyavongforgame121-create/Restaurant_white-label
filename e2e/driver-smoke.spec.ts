import { test, expect } from '@playwright/test';

/**
 * E2E: driver app login + main shell render.
 * Requires `pnpm dev:driver` running on :3001.
 */
test.describe('driver smoke', () => {
  test.use({ baseURL: 'http://localhost:3001' });

  test('login screen prompts for phone', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByText(/phone/i).first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByPlaceholder(/\(.*\)/).first()).toBeVisible();
  });
});
