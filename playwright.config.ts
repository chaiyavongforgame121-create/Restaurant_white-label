import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright E2E config — runs against locally-running apps.
 * Start `pnpm dev` first, then run `pnpm test:e2e`.
 *
 * Each project declares which specs it owns. Without `testMatch` a project runs the
 * WHOLE testDir, so the two projects were running every spec twice — once with the
 * customer baseURL and once with the admin one. Half those runs were meaningless
 * (the admin project loading customer pages), and a failure told you nothing about
 * which app was broken.
 *
 * Specs that address apps by absolute URL (driver, and the cross-app route sweep) sit
 * in `cross-app` so they run exactly once.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  // Must stay ABOVE navigationTimeout below, or raising that one achieves nothing: the
  // per-test budget fires first and the run fails with a vaguer message than before. That
  // is exactly what happened when navigationTimeout went 20s -> 60s and this was left at
  // Playwright's 30s default.
  timeout: 90_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    // 20s produced one false failure per full-suite run — a different route each time
    // (kitchen on one run, drivers on the next), every one of them passing on its own.
    // The cause is always the same: `next dev` compiles a route on first hit, and under a
    // 59-test sweep that first hit can exceed 20s on a cold cache.
    //
    // Raising this does not paper over a latency regression, because these specs never
    // asserted latency — they assert "returns <500 and throws no page errors". The
    // navigation budget here is a dev-server COMPILE budget, and 20s was simply the wrong
    // number for it. Run against a production build and the compile disappears entirely.
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'customer-web',
      testMatch: ['**/customer-*.spec.ts', '**/web-*.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3000' },
    },
    {
      name: 'admin',
      testMatch: ['**/admin-*.spec.ts'],
      use: { ...devices['Desktop Chrome'], baseURL: 'http://localhost:3004' },
    },
    {
      name: 'cross-app',
      testMatch: ['**/driver-*.spec.ts', '**/pos-kds-*.spec.ts'],
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
