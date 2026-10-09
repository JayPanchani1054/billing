// Smoke tests for the packaged-equivalent build (out/). Each run uses a throw-away profile and data
// folder via BAHI_USER_DATA / BAHI_DATA_DIR so it never touches a developer's real data.
import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import type { ApiResult } from '../src/shared/api.ts';
import { captureFailures, closeApp, launchApp } from './support.ts';
import type { LaunchedApp } from './support.ts';

let launched: LaunchedApp | undefined;
let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  launched = await launchApp('bahi-e2e-');
  ({ app, page } = launched);
});

captureFailures(() => launched);

test.afterAll(async ({}, testInfo) => {
  await closeApp(launched, testInfo);
});

test('main window opens with the product title', async () => {
  await expect
    .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getTitle() ?? ''))
    .toContain('Bahi ERP');
  const url = page.url();
  expect(url.startsWith('app://bahi/')).toBe(true);
});

test('window.bahi exposes exactly the documented bridge', async () => {
  const shape = await page.evaluate(() => {
    const bahi = (globalThis as unknown as { bahi?: Record<string, unknown> }).bahi;
    return bahi ? Object.keys(bahi).sort() : null;
  });
  expect(shape).toEqual(['api', 'native', 'on', 'platform', 'setDirty']);
});

test('app.state resolves through the IPC bridge', async () => {
  const result = await page.evaluate(() => {
    const bahi = (globalThis as unknown as { bahi: { api(route: string, input: unknown): Promise<unknown> } }).bahi;
    return bahi.api('app.state', {});
  });
  expect((result as ApiResult<unknown>).ok).toBe(true);
});

test('renderer has no Node.js access', async () => {
  const leaks = await page.evaluate(() => {
    const g = globalThis as Record<string, unknown>;
    return { require: typeof g.require, process: typeof g.process, module: typeof g.module, Buffer: typeof g.Buffer };
  });
  expect(leaks).toEqual({ require: 'undefined', process: 'undefined', module: 'undefined', Buffer: 'undefined' });
});

test('malformed IPC requests are rejected, not thrown', async () => {
  const results = await page.evaluate(async () => {
    const bahi = (globalThis as unknown as { bahi: { api(route: unknown, input: unknown): Promise<unknown>; native(a: unknown, p: unknown): Promise<unknown> } }).bahi;
    return Promise.all([bahi.api(42, {}), bahi.api('constructor', {}), bahi.api('x'.repeat(500), {}), bahi.native('no.such.action', {})]);
  });
  for (const r of results as Array<ApiResult<unknown>>) expect(r.ok).toBe(false);
});

test('the renderer cannot reach the network', async () => {
  const outcome = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/', { mode: 'no-cors' });
      return 'reached';
    } catch {
      return 'blocked';
    }
  });
  expect(outcome).toBe('blocked');
});
