import { test, expect } from '@playwright/test';

// POS = tablet landscape primary; KDS = large tablet / TV.

test.describe('pos @ tablet-1024', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('renders without horizontal overflow', async ({ page }) => {
    await page.goto('http://localhost:3003');
    await page.waitForLoadState('networkidle');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth, `no horizontal scroll at 1024px`).toBeLessThanOrEqual(clientWidth + 1);
  });
});

test.describe('kds @ tablet-1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('renders without horizontal overflow', async ({ page }) => {
    await page.goto('http://localhost:3002');
    await page.waitForLoadState('networkidle');
    const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
    const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
    expect(scrollWidth, `no horizontal scroll at 1280px`).toBeLessThanOrEqual(clientWidth + 1);
  });
});
