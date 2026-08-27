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
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'on-first-retry',
    actionTimeout: 10_000,
    navigationTimeout: 20_000,
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
