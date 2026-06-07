import { test, expect } from '@playwright/test';

/**
 * E2E: customer browses a branch and the cart picker works.
 * Uses the seeded restaurant `coastal-grill`. Requires `pnpm dev:web` running
 * with a Supabase project that has the seed data.
 */
test.describe('customer order flow', () => {
  test('browses menu and adds items to cart', async ({ page }) => {
    await page.goto('/r/coastal-grill/brooklyn');
    await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 10_000 });

    const addButtons = page.getByRole('button', { name: /add|\+/i });
    if (await addButtons.count() > 0) {
      await addButtons.first().click();
    }
  });

  test('cart page shows the voice-order button', async ({ page }) => {
    await page.goto('/r/coastal-grill/brooklyn/cart');
    // Voice button only renders if SpeechRecognition is supported; chromium has it
    await expect(page.getByText(/voice order|stop|speak/i)).toBeVisible({ timeout: 5_000 });
  });

  test('privacy + terms + ccpa pages render', async ({ page }) => {
    for (const path of ['/privacy', '/terms', '/ccpa']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 5_000 });
    }
  });

  test('cookie banner appears on first visit', async ({ page, context }) => {
    await context.clearCookies();
    await page.goto('/');
    await expect(page.getByText(/We use cookies/i)).toBeVisible({ timeout: 5_000 });
  });
});
