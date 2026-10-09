// Playwright drives the built Electron app (out/main/index.cjs) — run `npm run build` first.
// On Linux CI the suite runs under xvfb-run; on Windows it runs directly (see .github/workflows/ci.yml).
//
// Failure evidence: the specs launch Electron themselves (e2e/support.ts), so Playwright's page-fixture
// `trace`/`screenshot` options do not apply to them; support.ts records a trace (kept as trace.zip in
// test-results/ only when a test failed) and attaches a window screenshot to every failing test.
// CI uploads test-results/ and playwright-report/ when the job fails.
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
  use: {
    // For any future spec that uses Playwright's own browser fixtures.
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
