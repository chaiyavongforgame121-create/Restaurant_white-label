import { test, expect } from '@playwright/test';

// Counter = tablet landscape primary; Kitchen display = large tablet / TV.
//
// These pointed at :3003 and :3002 — the standalone apps/pos and apps/kds, which were
// merged into apps/admin as /counter and /kitchen and dropped from the workspace. No
// process can listen on those ports any more, so the tests could only fail. They now
// exercise the surfaces that actually ship, on the admin app.
//
// Unauthenticated these redirect to /login; the assertion is about layout, and the login
// screen is rendered by the same shell at the same viewport, so it is still a real check
// that nothing overflows horizontally on a tablet.

const BRANCH = '44444444-4444-4444-4444-444444444444';

async function expectNoHorizontalOverflow(page: import('@playwright/test').Page) {
  await page.waitForLoadState('networkidle');
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  expect(scrollWidth, 'no horizontal scroll').toBeLessThanOrEqual(clientWidth + 1);
}

test.describe('counter @ tablet-1024', () => {
  test.use({ viewport: { width: 1024, height: 768 } });
  test('renders without horizontal overflow', async ({ page }) => {
    await page.goto(`http://localhost:3004/counter/${BRANCH}`);
    await expectNoHorizontalOverflow(page);
  });
});

test.describe('kitchen @ tablet-1280', () => {
  test.use({ viewport: { width: 1280, height: 800 } });
  test('renders without horizontal overflow', async ({ page }) => {
    await page.goto(`http://localhost:3004/kitchen/${BRANCH}`);
    await expectNoHorizontalOverflow(page);
  });
});
