// Playwright drives the built Electron app (out/main/index.cjs) — run `npm run build` first.
// On Linux CI the suite runs under xvfb-run (see .github/workflows/ci.yml).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  // One Electron instance at a time: each spec launches its own app with an isolated profile.
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]] : 'list',
});
